import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { TranslationContext } from "cyrus-core";
import { createLogger, type ILogger } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { EventDeduplicator } from "./EventDeduplicator.js";
import { FeishuMessageTranslator } from "./FeishuMessageTranslator.js";
import { normalizeFeishuMessageEvent } from "./normalize.js";
import type {
	FeishuEventEnvelope,
	FeishuEventTransportConfig,
	FeishuEventTransportEvents,
	FeishuMessageReceiveEvent,
	FeishuVerificationMode,
	FeishuWebhookEvent,
} from "./types.js";

export declare interface FeishuEventTransport {
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
 * FeishuEventTransport - Handles Feishu (Lark) webhook event delivery.
 *
 * Registers a POST /feishu-webhook endpoint with a Fastify server and processes
 * Feishu event-subscription deliveries. Mirrors SlackEventTransport, with two
 * verification modes:
 * - 'direct': Feishu → runtime. Answers the url_verification challenge, decrypts
 *   the `encrypt` payload (AES-256-CBC) when an Encrypt Key is configured,
 *   verifies the `X-Lark-Signature` header when present, and checks the
 *   Verification Token.
 * - 'proxy': events forwarded from CYHOST with Bearer-token auth.
 *
 * It recognizes `im.message.receive_v1` events, classifies each as a `mention`
 * (bot @mentioned, or a p2p chat) or a plain `message` (thread follow-up), and
 * emits three events: `event` (raw FeishuWebhookEvent), `message` (translated
 * InternalMessage) and `error`.
 */
export class FeishuEventTransport extends EventEmitter {
	private config: FeishuEventTransportConfig;
	private logger: ILogger;
	private messageTranslator: FeishuMessageTranslator;
	private translationContext: TranslationContext;
	/**
	 * Deduplicator for `event_id`s (drops Feishu retry re-deliveries). Shared with
	 * the long-connection client when one is injected, so an event delivered over
	 * both transports is processed once; otherwise a private window per IN-50.
	 */
	private deduplicator: EventDeduplicator;

	constructor(
		config: FeishuEventTransportConfig,
		logger?: ILogger,
		translationContext?: TranslationContext,
	) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "FeishuEventTransport" });
		this.messageTranslator = new FeishuMessageTranslator();
		this.translationContext = translationContext ?? {};
		this.deduplicator = config.deduplicator ?? new EventDeduplicator();
	}

	/** Set the translation context for message translation. */
	setTranslationContext(context: TranslationContext): void {
		this.translationContext = { ...this.translationContext, ...context };
	}

	/**
	 * Resolve the effective verification mode and secrets at request time.
	 * Like Slack, a process started in proxy mode can upgrade to direct
	 * verification once the direct-mode env vars appear.
	 */
	private resolveVerification(): {
		mode: FeishuVerificationMode;
		secret: string;
		verificationToken: string | undefined;
		encryptKey: string | undefined;
	} {
		if (this.config.verificationMode === "direct") {
			return {
				mode: "direct",
				secret: this.config.secret,
				verificationToken: this.config.verificationToken,
				encryptKey: this.config.encryptKey,
			};
		}

		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const verificationToken =
			this.config.verificationToken || process.env.FEISHU_VERIFICATION_TOKEN;
		const encryptKey = this.config.encryptKey || process.env.FEISHU_ENCRYPT_KEY;

		if (isExternalHost && (verificationToken || encryptKey)) {
			this.logger.info(
				"Runtime switch: Feishu direct verification credentials detected, using direct mode",
			);
			return {
				mode: "direct",
				secret: this.config.secret,
				verificationToken,
				encryptKey,
			};
		}

		return {
			mode: "proxy",
			secret: this.config.secret,
			verificationToken,
			encryptKey,
		};
	}

	/** Register the /feishu-webhook endpoint with the Fastify server. */
	register(): void {
		this.config.fastifyServer.post(
			"/feishu-webhook",
			{ config: { rawBody: true } },
			async (request: FastifyRequest, reply: FastifyReply) => {
				try {
					const { mode, secret, verificationToken, encryptKey } =
						this.resolveVerification();

					if (mode === "direct") {
						await this.handleDirectWebhook(
							request,
							reply,
							verificationToken,
							encryptKey,
						);
					} else {
						await this.handleProxyWebhook(
							request,
							reply,
							secret,
							verificationToken,
						);
					}
				} catch (error) {
					const err = new Error("Webhook error");
					if (error instanceof Error) {
						err.cause = error;
					}
					this.logger.error("Webhook error", err);
					this.emit("error", err);
					reply.code(500).send({ error: "Internal server error" });
				}
			},
		);

		this.logger.info(
			`Registered POST /feishu-webhook endpoint (${this.config.verificationMode} mode)`,
		);
	}

	/**
	 * Handle a webhook delivered directly from Feishu: decrypt when encrypted,
	 * verify the signature when present, then process the plaintext envelope.
	 */
	private async handleDirectWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
		verificationToken: string | undefined,
		encryptKey: string | undefined,
	): Promise<void> {
		const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
		const bodyText =
			rawBody ??
			(typeof request.body === "string"
				? request.body
				: JSON.stringify(request.body ?? {}));

		let outer: FeishuEventEnvelope & { encrypt?: string };
		try {
			outer = JSON.parse(bodyText) as FeishuEventEnvelope & {
				encrypt?: string;
			};
		} catch {
			reply.code(400).send({ error: "Invalid JSON body" });
			return;
		}

		let envelope: FeishuEventEnvelope = outer;

		if (outer.encrypt) {
			if (!encryptKey) {
				this.logger.error(
					"Received an encrypted Feishu event but no FEISHU_ENCRYPT_KEY is configured",
				);
				reply.code(401).send({ error: "Encryption not configured" });
				return;
			}

			// Verify X-Lark-Signature when Feishu includes it (encrypt mode).
			const signature = request.headers["x-lark-signature"] as
				| string
				| undefined;
			const timestamp = request.headers["x-lark-request-timestamp"] as
				| string
				| undefined;
			const nonce = request.headers["x-lark-request-nonce"] as
				| string
				| undefined;
			if (signature && timestamp && nonce && rawBody) {
				if (
					!this.verifyFeishuSignature(
						timestamp,
						nonce,
						encryptKey,
						rawBody,
						signature,
					)
				) {
					reply.code(401).send({ error: "Invalid webhook signature" });
					return;
				}
			}

			try {
				const decrypted = this.decrypt(outer.encrypt, encryptKey);
				envelope = JSON.parse(decrypted) as FeishuEventEnvelope;
			} catch (error) {
				const err = new Error("Feishu event decryption failed");
				if (error instanceof Error) err.cause = error;
				this.logger.error("Feishu event decryption failed", err);
				reply.code(401).send({ error: "Decryption failed" });
				return;
			}
		}

		this.processAndEmitEvent(envelope, reply, verificationToken, false);
	}

	/**
	 * Handle a webhook forwarded from CYHOST with Bearer-token auth.
	 */
	private async handleProxyWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
		secret: string,
		verificationToken: string | undefined,
	): Promise<void> {
		const authHeader = request.headers.authorization;
		if (!authHeader) {
			reply.code(401).send({ error: "Missing Authorization header" });
			return;
		}
		if (authHeader !== `Bearer ${secret}`) {
			reply.code(401).send({ error: "Invalid authorization token" });
			return;
		}

		const envelope = request.body as FeishuEventEnvelope;
		this.processAndEmitEvent(envelope, reply, verificationToken, true);
	}

	/**
	 * AES-256-CBC decrypt a Feishu `encrypt` field.
	 * Key = SHA256(encryptKey); IV = first 16 bytes of the base64-decoded body.
	 */
	private decrypt(encrypt: string, encryptKey: string): string {
		const key = createHash("sha256").update(encryptKey).digest();
		const data = Buffer.from(encrypt, "base64");
		const iv = data.subarray(0, 16);
		const ciphertext = data.subarray(16);
		const decipher = createDecipheriv("aes-256-cbc", key, iv);
		const decrypted = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]);
		return decrypted.toString("utf8");
	}

	/**
	 * Verify a Feishu `X-Lark-Signature`.
	 * signature = SHA256(timestamp + nonce + encryptKey + rawBody) hex.
	 */
	private verifyFeishuSignature(
		timestamp: string,
		nonce: string,
		encryptKey: string,
		rawBody: string,
		signature: string,
	): boolean {
		const content = timestamp + nonce + encryptKey + rawBody;
		const expected = createHash("sha256").update(content).digest("hex");
		if (signature.length !== expected.length) {
			return false;
		}
		return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
	}

	/**
	 * Process a (decrypted) Feishu envelope and emit the appropriate events.
	 */
	private processAndEmitEvent(
		envelope: FeishuEventEnvelope,
		reply: FastifyReply,
		verificationToken: string | undefined,
		upstreamGated: boolean,
	): void {
		// URL verification handshake
		if (envelope.type === "url_verification") {
			if (
				verificationToken &&
				envelope.token &&
				envelope.token !== verificationToken
			) {
				this.logger.warn("Feishu url_verification token mismatch — rejecting");
				reply.code(401).send({ error: "Invalid verification token" });
				return;
			}
			this.logger.info("Responding to Feishu URL verification challenge");
			reply.code(200).send({ challenge: envelope.challenge });
			return;
		}

		const header = envelope.header;
		const eventType = header?.event_type;
		if (eventType !== "im.message.receive_v1") {
			this.logger.debug(
				`Ignoring unsupported Feishu event type: ${eventType ?? "unknown"}`,
			);
			reply.code(200).send({ code: 0 });
			return;
		}

		// Verify the Verification Token (secondary auth alongside the signature).
		if (
			verificationToken &&
			header?.token &&
			header.token !== verificationToken
		) {
			this.logger.warn("Feishu event token mismatch — rejecting");
			reply.code(401).send({ error: "Invalid verification token" });
			return;
		}

		// De-dup on event_id (Feishu retries reuse it, and the webhook + long
		// connection can each deliver the same id — the shared deduplicator
		// collapses both into one).
		const eventId = header?.event_id ?? "";
		if (eventId && !this.deduplicator.markSeen(eventId)) {
			this.logger.debug(
				`Ignoring duplicate Feishu event ${eventId} (already processed)`,
			);
			reply.code(200).send({ code: 0 });
			return;
		}

		const messageEvent = envelope.event as
			| FeishuMessageReceiveEvent
			| undefined;

		const result = normalizeFeishuMessageEvent(
			{
				eventId,
				tenantKey: header?.tenant_key ?? "",
				createTime: header?.create_time ?? "",
				sender: messageEvent?.sender,
				message: messageEvent?.message,
			},
			{
				getBotOpenId: this.config.getBotOpenId,
				isThreadFollowingEnabled: this.config.isThreadFollowingEnabled,
				upstreamGated,
			},
		);

		if ("ignored" in result) {
			this.logger.debug(`Ignoring Feishu event ${eventId}: ${result.ignored}`);
			reply.code(200).send({ code: 0 });
			return;
		}

		const webhookEvent = result.event;
		this.logger.info(
			`Received Feishu ${webhookEvent.eventType} (event: ${eventId}, chat: ${webhookEvent.payload.chatId})`,
		);

		this.emit("event", webhookEvent);
		this.emitMessage(webhookEvent);

		reply.code(200).send({ code: 0 });
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
