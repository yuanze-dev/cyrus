import { EventEmitter } from "node:events";
import * as lark from "@larksuiteoapi/node-sdk";
import type { TranslationContext } from "cyrus-core";
import { createLogger, type ILogger } from "cyrus-core";
import { EventDeduplicator } from "./EventDeduplicator.js";
import { FeishuMessageTranslator } from "./FeishuMessageTranslator.js";
import { normalizeFeishuMessageEvent } from "./normalize.js";
import type {
	FeishuEventTransportEvents,
	FeishuMessageReceiveEvent,
	FeishuWebhookEvent,
} from "./types.js";

export declare interface FeishuWsClient {
	on<K extends keyof FeishuEventTransportEvents>(
		event: K,
		listener: FeishuEventTransportEvents[K],
	): this;
	emit<K extends keyof FeishuEventTransportEvents>(
		event: K,
		...args: Parameters<FeishuEventTransportEvents[K]>
	): boolean;
}

/**
 * Configuration for FeishuWsClient.
 */
export interface FeishuWsClientConfig {
	/** Feishu app id (e.g. "cli_...") */
	appId: string;
	/** Feishu app secret */
	appSecret: string;
	/** Which platform: "feishu" (open.feishu.cn) or "lark" (larksuite.com). Default "feishu". */
	domain?: "feishu" | "lark";
	/** Live predicate: follow plain (non-@mention) thread messages? Omitted ⇒ enabled. */
	isThreadFollowingEnabled?: () => boolean;
	/** Live read of the bot's own open_id, for mention detection + self-drop. */
	getBotOpenId?: () => string | undefined;
	/**
	 * Shared `event_id` deduplicator (IN-42 §5 P5 / IN-50). Pass the SAME instance
	 * used by {@link FeishuEventTransport} so an event delivered over both the
	 * webhook and this long connection is injected once. Omit to fall back to a
	 * private per-client window (legacy behavior).
	 */
	deduplicator?: EventDeduplicator;
}

/** The flattened data the SDK EventDispatcher hands to an im.message.receive_v1 handler. */
interface FeishuWsMessageData {
	event_id?: string;
	tenant_key?: string;
	create_time?: string;
	sender?: FeishuMessageReceiveEvent["sender"];
	message?: FeishuMessageReceiveEvent["message"];
}

/**
 * FeishuWsClient — receives Feishu events over a **long connection** (WebSocket)
 * using the official `@larksuiteoapi/node-sdk`, so **no public callback URL** is
 * required. The SDK connects out to Feishu, authenticates with the app
 * credentials, and pushes decrypted events; there is no URL verification,
 * Encrypt Key, Verification Token, or signature to configure.
 *
 * It classifies each `im.message.receive_v1` event with the same
 * {@link normalizeFeishuMessageEvent} logic the webhook transport uses, and
 * emits the same `event` / `message` / `error` events, so downstream wiring
 * (EdgeWorker → ChatSessionHandler) is identical to the webhook path.
 */
export class FeishuWsClient extends EventEmitter {
	private config: FeishuWsClientConfig;
	private logger: ILogger;
	private messageTranslator: FeishuMessageTranslator;
	private translationContext: TranslationContext;
	private wsClient: lark.WSClient | undefined;
	/**
	 * Deduplicator for `event_id`s (drops redeliveries on reconnect). Shared with
	 * the webhook transport when one is injected, so an event delivered over both
	 * is processed once; otherwise a private window per IN-50.
	 */
	private deduplicator: EventDeduplicator;

	constructor(
		config: FeishuWsClientConfig,
		logger?: ILogger,
		translationContext?: TranslationContext,
	) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "FeishuWsClient" });
		this.messageTranslator = new FeishuMessageTranslator();
		this.translationContext = translationContext ?? {};
		this.deduplicator = config.deduplicator ?? new EventDeduplicator();
	}

	/** Set the translation context for message translation. */
	setTranslationContext(context: TranslationContext): void {
		this.translationContext = { ...this.translationContext, ...context };
	}

	/**
	 * Open the long connection and start receiving events. Auto-reconnects.
	 * Non-fatal: connection errors are surfaced via the `error` event.
	 */
	start(): void {
		const domain =
			this.config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

		this.wsClient = new lark.WSClient({
			appId: this.config.appId,
			appSecret: this.config.appSecret,
			domain,
			loggerLevel: lark.LoggerLevel.warn,
			onReady: () => {
				this.logger.info("Feishu long connection ready");
			},
			onError: (err: Error) => {
				this.logger.error("Feishu long connection error", err);
				this.emit("error", err);
			},
			onReconnecting: () => {
				this.logger.warn("Feishu long connection reconnecting…");
			},
			onReconnected: () => {
				this.logger.info("Feishu long connection reconnected");
			},
		});

		const dispatcher = new lark.EventDispatcher({}).register({
			"im.message.receive_v1": async (data: unknown) => {
				this.handleMessageEvent(data as FeishuWsMessageData);
			},
		});

		this.wsClient.start({ eventDispatcher: dispatcher });
		this.logger.info("Feishu long-connection client started");
	}

	/** Close the long connection (best-effort). */
	close(): void {
		try {
			this.wsClient?.close?.();
		} catch (error) {
			this.logger.warn(
				`Failed to close Feishu long connection: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.wsClient = undefined;
	}

	private handleMessageEvent(data: FeishuWsMessageData): void {
		try {
			const eventId = data.event_id ?? data.message?.message_id ?? "";
			if (eventId && !this.deduplicator.markSeen(eventId)) {
				this.logger.debug(`Ignoring duplicate Feishu event ${eventId}`);
				return;
			}

			const result = normalizeFeishuMessageEvent(
				{
					eventId,
					tenantKey: data.tenant_key ?? "",
					createTime: data.create_time ?? "",
					sender: data.sender,
					message: data.message,
				},
				{
					getBotOpenId: this.config.getBotOpenId,
					isThreadFollowingEnabled: this.config.isThreadFollowingEnabled,
				},
			);

			if ("ignored" in result) {
				this.logger.debug(
					`Ignoring Feishu event ${eventId}: ${result.ignored}`,
				);
				return;
			}

			this.logger.info(
				`Received Feishu ${result.event.eventType} via long connection (event: ${eventId}, chat: ${result.event.payload.chatId})`,
			);
			this.emit("event", result.event);
			this.emitMessage(result.event);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger.error("Failed to handle Feishu long-connection event", err);
			this.emit("error", err);
		}
	}

	private emitMessage(event: FeishuWebhookEvent): void {
		const result = this.messageTranslator.translate(
			event,
			this.translationContext,
		);
		if (result.success) {
			this.emit("message", result.message);
		} else {
			this.logger.debug(`Message translation skipped: ${result.reason}`);
		}
	}
}
