/**
 * Feishu Message Translator
 *
 * Translates normalized Feishu webhook events into unified internal messages
 * for the internal message bus. Mirrors SlackMessageTranslator.
 *
 * @module feishu-event-transport/FeishuMessageTranslator
 */

import { randomUUID } from "node:crypto";
import type {
	FeishuPlatformRef,
	FeishuSessionStartPlatformData,
	FeishuUserPromptPlatformData,
	IMessageTranslator,
	SessionStartMessage,
	TranslationContext,
	TranslationResult,
	UserPromptMessage,
} from "cyrus-core";
import type {
	FeishuEventPayload,
	FeishuMention,
	FeishuWebhookEvent,
} from "./types.js";

/** A node inside a Feishu `post` rich-text message. */
interface FeishuPostNode {
	tag?: string;
	text?: string;
	href?: string;
	user_name?: string;
}

/**
 * Strip / resolve Feishu @mention placeholders (`@_user_N`, `@_all`) in a text
 * message. Named mentions are replaced with `@<name>`, unnamed placeholders are
 * removed, and whitespace is collapsed.
 */
export function stripMention(text: string, mentions?: FeishuMention[]): string {
	let out = text || "";
	for (const mention of mentions ?? []) {
		if (!mention.key) continue;
		const replacement = mention.name ? `@${mention.name}` : "";
		out = out.split(mention.key).join(replacement);
	}
	// Remove any leftover placeholder tokens not covered by the mentions array.
	out = out.replace(/@_user_\d+/g, "").replace(/@_all/g, "");
	return out
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Flatten a Feishu `post` (rich text) content object to plain text. */
function flattenPost(parsed: Record<string, unknown>): string {
	let doc = parsed;
	if (!Array.isArray((parsed as { content?: unknown }).content)) {
		// Locale-keyed shape: { zh_cn: { title, content }, en_us: {...} }
		const localized = Object.values(parsed).find(
			(v): v is Record<string, unknown> =>
				!!v &&
				typeof v === "object" &&
				Array.isArray((v as { content?: unknown }).content),
		);
		if (localized) doc = localized;
	}

	const title = typeof doc.title === "string" ? doc.title : "";
	const lines: string[] = [];
	const content = (doc as { content?: unknown }).content;
	if (Array.isArray(content)) {
		for (const line of content) {
			if (!Array.isArray(line)) continue;
			const parts: string[] = [];
			for (const node of line as FeishuPostNode[]) {
				if (!node || typeof node !== "object") continue;
				if (node.tag === "text" && typeof node.text === "string") {
					parts.push(node.text);
				} else if (node.tag === "a") {
					parts.push(node.text || node.href || "");
				} else if (node.tag === "at") {
					parts.push(node.user_name ? `@${node.user_name}` : "");
				} else if (typeof node.text === "string") {
					parts.push(node.text);
				}
			}
			lines.push(parts.join(""));
		}
	}

	return [title, lines.join("\n")].filter(Boolean).join("\n").trim();
}

/**
 * Decode a Feishu message `content` JSON string into plain prompt text.
 * Handles `text` and `post` message types; other types yield "".
 */
export function decodeFeishuContent(
	messageType: string,
	content: string,
	mentions?: FeishuMention[],
): string {
	if (!content) return "";
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(content) as Record<string, unknown>;
	} catch {
		return "";
	}

	if (messageType === "post") {
		return flattenPost(parsed);
	}

	const raw = typeof parsed.text === "string" ? parsed.text : "";
	return stripMention(raw, mentions);
}

/** The prompt text for a Feishu payload (decoded content, mentions resolved). */
export function buildPromptText(payload: FeishuEventPayload): string {
	if (payload.text) return payload.text;
	return decodeFeishuContent(
		payload.messageType,
		payload.rawContent,
		payload.mentions,
	);
}

/**
 * Derive the thread root shared by every message in a Feishu conversation.
 *
 * Keys on the conversation ROOT MESSAGE id so an initiating @mention and all its
 * in-thread follow-ups agree, across every Feishu flow:
 * - A reply (topic or plain) carries `root_id` = the topic/thread root message
 *   id, so it keys on `rootId`.
 * - The root message itself has no `root_id`, so it keys on its own `messageId`.
 * Because a reply's `root_id` equals the root message's `messageId`, the two
 * always collide.
 *
 * `thread_id` (`omt_…`) is deliberately NOT used: it is absent on a plain
 * @mention that only becomes a topic after Cyrus replies `reply_in_thread`, yet
 * present on the subsequent follow-ups — so keying on it would split one
 * conversation across two sessions. `root_id`/`messageId` are stable across the
 * whole flow.
 */
export function feishuThreadRoot(payload: FeishuEventPayload): string {
	return payload.rootId || payload.messageId;
}

/**
 * Translates Feishu webhook events into internal messages.
 *
 * Note: Feishu webhooks can result in either:
 * - SessionStartMessage: first @mention in a chat/thread that starts a session
 * - UserPromptMessage: follow-up messages in an existing thread session
 */
export class FeishuMessageTranslator
	implements IMessageTranslator<FeishuWebhookEvent>
{
	canTranslate(event: unknown): event is FeishuWebhookEvent {
		if (!event || typeof event !== "object") {
			return false;
		}
		const e = event as Record<string, unknown>;
		return (
			typeof e.eventType === "string" &&
			(e.eventType === "mention" || e.eventType === "message") &&
			typeof e.eventId === "string" &&
			e.payload !== null &&
			typeof e.payload === "object"
		);
	}

	translate(
		event: FeishuWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		if (event.eventType === "mention") {
			return this.translateMention(event, context);
		}
		if (event.eventType === "message") {
			return this.translateAsUserPrompt(event, context);
		}
		return {
			success: false,
			reason: `Unsupported Feishu event type: ${event.eventType}`,
		};
	}

	/**
	 * Create a UserPromptMessage from a Feishu event (follow-up in an existing
	 * session). Public — called by consumers that already know this is a prompt.
	 */
	translateAsUserPrompt(
		event: FeishuWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		if (event.eventType !== "mention" && event.eventType !== "message") {
			return {
				success: false,
				reason: `Unsupported Feishu event type: ${event.eventType}`,
			};
		}

		const { payload } = event;
		const organizationId = context?.organizationId || event.tenantKey;
		const threadRoot = feishuThreadRoot(payload);
		const sessionKey = `${payload.chatId}:${threadRoot}`;
		const promptText = buildPromptText(payload);

		const platformData: FeishuUserPromptPlatformData = {
			chat: this.buildChatRef(payload),
			thread: this.buildThreadRef(payload),
			message: this.buildMessageRef(payload),
			tenantKey: event.tenantKey,
		};

		const message: UserPromptMessage = {
			id: randomUUID(),
			source: "feishu",
			action: "user_prompt",
			receivedAt: this.toIso(payload.createTime),
			organizationId,
			sessionKey,
			workItemId: `${payload.chatId}:${threadRoot}`,
			workItemIdentifier: `feishu:${payload.chatId}:${threadRoot}`,
			author: { id: payload.user, name: payload.user },
			content: promptText,
			platformData,
		};

		return { success: true, message };
	}

	private translateMention(
		event: FeishuWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		const { payload } = event;
		const organizationId = context?.organizationId || event.tenantKey;
		const threadRoot = feishuThreadRoot(payload);
		const sessionKey = `${payload.chatId}:${threadRoot}`;
		const promptText = buildPromptText(payload);

		const platformData: FeishuSessionStartPlatformData = {
			chat: this.buildChatRef(payload),
			thread: this.buildThreadRef(payload),
			message: this.buildMessageRef(payload),
			tenantKey: event.tenantKey,
		};

		const message: SessionStartMessage = {
			id: randomUUID(),
			source: "feishu",
			action: "session_start",
			receivedAt: this.toIso(payload.createTime),
			organizationId,
			sessionKey,
			workItemId: `${payload.chatId}:${threadRoot}`,
			workItemIdentifier: `feishu:${payload.chatId}:${threadRoot}`,
			author: { id: payload.user, name: payload.user },
			initialPrompt: promptText,
			title: promptText.slice(0, 100) + (promptText.length > 100 ? "..." : ""),
			platformData,
		};

		return { success: true, message };
	}

	// ==========================================================================
	// HELPERS
	// ==========================================================================

	private toIso(createTime: string): string {
		const ms = Number(createTime);
		if (Number.isFinite(ms) && ms > 0) {
			return new Date(ms).toISOString();
		}
		return new Date(0).toISOString();
	}

	private buildChatRef(payload: FeishuEventPayload): FeishuPlatformRef["chat"] {
		return { id: payload.chatId, type: payload.chatType };
	}

	private buildThreadRef(
		payload: FeishuEventPayload,
	): FeishuPlatformRef["thread"] {
		return {
			messageId: payload.messageId,
			rootId: payload.rootId,
			threadId: payload.threadId,
		};
	}

	private buildMessageRef(
		payload: FeishuEventPayload,
	): FeishuPlatformRef["message"] {
		return {
			messageId: payload.messageId,
			text: payload.text,
			user: { id: payload.user },
		};
	}
}
