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
	/** `image_key` of an inline `img` element (post rich text). */
	image_key?: string;
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

/**
 * Collect every inline `img` element's `image_key` from a decoded Feishu `post`
 * (rich text) content object, walking every line/node (handling the
 * locale-keyed `{ zh_cn: { content } }` shape the same way {@link flattenPost}
 * does).
 */
function collectPostImageKeys(parsed: Record<string, unknown>): string[] {
	let doc = parsed;
	if (!Array.isArray((parsed as { content?: unknown }).content)) {
		const localized = Object.values(parsed).find(
			(v): v is Record<string, unknown> =>
				!!v &&
				typeof v === "object" &&
				Array.isArray((v as { content?: unknown }).content),
		);
		if (localized) doc = localized;
	}

	const keys: string[] = [];
	const content = (doc as { content?: unknown }).content;
	if (Array.isArray(content)) {
		for (const line of content) {
			if (!Array.isArray(line)) continue;
			for (const node of line as FeishuPostNode[]) {
				if (node && typeof node === "object" && node.tag === "img") {
					if (typeof node.image_key === "string" && node.image_key) {
						keys.push(node.image_key);
					}
				}
			}
		}
	}
	return keys;
}

/**
 * Decode the `image_key`s carried by a Feishu message `content` JSON string:
 * the single key of an `image` message, or every inline `img` element's key in a
 * `post` rich-text message. Other message types (and unparseable content) yield
 * an empty array.
 */
export function decodeFeishuImageKeys(
	messageType: string,
	content: string,
): string[] {
	if (!content) return [];
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(content) as Record<string, unknown>;
	} catch {
		return [];
	}

	if (messageType === "image") {
		return typeof parsed.image_key === "string" && parsed.image_key
			? [parsed.image_key]
			: [];
	}
	if (messageType === "post") {
		return collectPostImageKeys(parsed);
	}
	return [];
}

/**
 * The `image_key`s of every image attached to a Feishu payload — a standalone
 * `image` message, or the images embedded in a `post`. Deduped, preserving
 * first-seen order. Empty for text-only / imageless messages.
 */
export function extractFeishuImageKeys(payload: FeishuEventPayload): string[] {
	const keys = decodeFeishuImageKeys(payload.messageType, payload.rawContent);
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const key of keys) {
		if (!seen.has(key)) {
			seen.add(key);
			deduped.push(key);
		}
	}
	return deduped;
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
 * The ordered set of identities a Feishu conversation can be keyed by, most
 * stable first: `thread_id` → `root_id` → `message_id`. Deduped, and never
 * empty (a message always has a `messageId`).
 *
 * `thread_id` (`omt_…`) leads because it is the ONE identity stable across an
 * entire Feishu topic: once Cyrus replies `reply_in_thread`, every subsequent
 * message in the topic carries the same `thread_id`, even when Feishu reroots a
 * reply's `root_id` onto a different card (the production failure this fixes —
 * the answer's `root_id` no longer matched the question's, so the two split
 * into separate zero-history sessions).
 *
 * The full ordered list is what makes the switch safe: the initiating @mention
 * of a plain group has no `thread_id` (the topic is only born once Cyrus
 * replies), so it keys on `root_id`/`messageId`, while its later in-topic
 * follow-ups key on `thread_id`. Consumers resolve a session against ALL of
 * these candidates (see `ChatSessionHandler`'s alias lookup), so the two halves
 * of one conversation still reconcile to a single session.
 *
 * @see feishuThreadRoot — the single canonical key (this list's head).
 */
export function feishuThreadRootCandidates(
	payload: FeishuEventPayload,
): string[] {
	const ordered = [payload.threadId, payload.rootId, payload.messageId];
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const id of ordered) {
		if (id && !seen.has(id)) {
			seen.add(id);
			candidates.push(id);
		}
	}
	return candidates;
}

/**
 * Derive the canonical thread root for a Feishu conversation: `thread_id` when
 * the message is in a topic, else `root_id` (a reply), else the message's own
 * `messageId` (a fresh @mention). This is the head of
 * {@link feishuThreadRootCandidates}; the remaining candidates back it up as
 * session-lookup aliases so a conversation whose key shifts from `messageId`/
 * `root_id` to `thread_id` mid-flight stays a single session.
 */
export function feishuThreadRoot(payload: FeishuEventPayload): string {
	return feishuThreadRootCandidates(payload)[0] ?? payload.messageId;
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
