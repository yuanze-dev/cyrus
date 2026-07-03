/**
 * Types for Feishu (Lark) event transport.
 *
 * Mirrors the shapes in `cyrus-slack-event-transport` but keyed by Feishu's
 * webhook schema (event subscription v2.0): a `header` carrying event metadata
 * and an `event` body carrying the `im.message.receive_v1` payload.
 */

import type { InternalMessage } from "cyrus-core";
import type { FastifyInstance } from "fastify";

/**
 * Verification mode for Feishu webhooks.
 * - 'proxy': Use a Bearer token for authentication (events forwarded from CYHOST).
 * - 'direct': Feishu delivers events straight to us — verify the Verification
 *   Token and, when an Encrypt Key is configured, AES-256-CBC decrypt the body.
 */
export type FeishuVerificationMode = "proxy" | "direct";

/**
 * Configuration for FeishuEventTransport.
 */
export interface FeishuEventTransportConfig {
	/** Fastify server instance to mount routes on */
	fastifyServer: FastifyInstance;
	/** Verification mode: 'proxy' (via CYHOST) or 'direct' (Feishu → runtime) */
	verificationMode: FeishuVerificationMode;
	/** Bearer secret for proxy mode (e.g. CYRUS_API_KEY) */
	secret: string;
	/**
	 * Feishu event "Verification Token". In direct mode the decrypted payload's
	 * `token` (v2 `header.token`, or the top-level `token` on url_verification)
	 * must equal this value. Omit to skip token verification (not recommended).
	 */
	verificationToken?: string;
	/**
	 * Feishu event "Encrypt Key". When set, Feishu delivers the body as
	 * `{ "encrypt": "<base64>" }` and this key is used to AES-256-CBC decrypt it
	 * (and to verify the `X-Lark-Signature` header when present). Omit when the
	 * app's event subscription is configured in plaintext mode.
	 */
	encryptKey?: string;
	/**
	 * Live predicate for whether Cyrus should follow plain (non-@mention)
	 * messages in a thread. When it returns false, plain `message` events are
	 * ignored entirely (mention-only behaviour). Omitted ⇒ always enabled.
	 */
	isThreadFollowingEnabled?: () => boolean;
	/**
	 * Live read of the bot's own `open_id`, used to (a) classify a message as a
	 * mention when the bot is @mentioned and (b) drop the bot's own messages.
	 * Resolved lazily by the FeishuTokenProvider; returns undefined until known,
	 * in which case the transport falls back to a group-heuristic classification.
	 */
	getBotOpenId?: () => string | undefined;
}

/**
 * Events emitted by FeishuEventTransport.
 */
export interface FeishuEventTransportEvents {
	/** Emitted when a Feishu webhook is received and verified */
	event: (event: FeishuWebhookEvent) => void;
	/** Emitted when a unified internal message is received */
	message: (message: InternalMessage) => void;
	/** Emitted when an error occurs */
	error: (error: Error) => void;
}

/**
 * Supported Feishu event classifications.
 *
 * - `mention`: the bot was @mentioned (or the message is a direct/p2p chat) —
 *   always starts (or resumes) a session for the thread.
 * - `message`: a plain message in a thread the bot follows — only acted on as a
 *   follow-up prompt for an already-bound thread; never starts a new session.
 */
export type FeishuEventType = "mention" | "message";

/**
 * A single @mention entry inside a Feishu message.
 */
export interface FeishuMention {
	/** Placeholder key inside the message text, e.g. "@_user_1" */
	key: string;
	/** Mentioned user's ids */
	id?: {
		open_id?: string;
		union_id?: string;
		user_id?: string;
	};
	/** Mentioned user's display name */
	name?: string;
	/** Tenant key */
	tenant_key?: string;
}

/**
 * Processed Feishu event payload (normalized from `im.message.receive_v1`).
 * Members mirror the fields SlackEventPayload exposes so downstream consumers
 * read them without narrowing.
 */
export interface FeishuEventPayload {
	/** Classified event type (mention vs plain message) */
	type: FeishuEventType;
	/** Sender open_id (e.g. "ou_...") */
	user: string;
	/** Decoded, mention-processed message text */
	text: string;
	/** Raw message content JSON string (as delivered by Feishu) */
	rawContent: string;
	/** Feishu message type ("text", "post", "image", ...) */
	messageType: string;
	/** Message ID (e.g. "om_...") — analog of Slack `ts` */
	messageId: string;
	/** Chat ID (e.g. "oc_...") — analog of Slack `channel` */
	chatId: string;
	/** Chat type ("group" | "p2p") */
	chatType: string;
	/** Thread root message ID (`root_id`), when this is a threaded reply */
	rootId?: string;
	/** Parent message ID (`parent_id`), when this is a reply */
	parentId?: string;
	/** Native Feishu thread ID (`thread_id`), when the message is in a thread */
	threadId?: string;
	/** Event create_time (millisecond epoch string) */
	createTime: string;
	/** @mentions carried by the message */
	mentions?: FeishuMention[];
}

/**
 * Processed Feishu webhook event that is emitted to listeners.
 */
export interface FeishuWebhookEvent {
	/** The classified Feishu event type */
	eventType: FeishuEventType;
	/** Unique event ID from Feishu (`header.event_id`) */
	eventId: string;
	/** The normalized Feishu event payload */
	payload: FeishuEventPayload;
	/** Feishu tenant key / workspace identifier (`header.tenant_key`) */
	tenantKey: string;
	/**
	 * True when the event arrived via an upstream gate that already verified it
	 * should be acted on (proxy mode). Lets a plain `message` event (re)start a
	 * session for its thread after a process restart wipes the in-memory binding.
	 * In direct mode this is false and the runtime self-gates on its bindings.
	 */
	upstreamGated?: boolean;
}

// ============================================================================
// Raw Feishu webhook envelope types (event subscription v2.0)
// ============================================================================

/** Encrypted delivery wrapper: `{ "encrypt": "<base64 ciphertext>" }`. */
export interface FeishuEncryptedEnvelope {
	encrypt: string;
}

/** Feishu event header (schema 2.0). */
export interface FeishuEventHeader {
	event_id: string;
	event_type: string;
	create_time: string;
	token: string;
	app_id: string;
	tenant_key: string;
}

/** The `im.message.receive_v1` event body. */
export interface FeishuMessageReceiveEvent {
	sender?: {
		sender_id?: {
			open_id?: string;
			union_id?: string;
			user_id?: string;
		};
		sender_type?: string;
		tenant_key?: string;
	};
	message?: {
		message_id: string;
		root_id?: string;
		parent_id?: string;
		thread_id?: string;
		create_time?: string;
		chat_id: string;
		chat_type?: string;
		message_type: string;
		content: string;
		mentions?: FeishuMention[];
	};
}

/**
 * Feishu webhook envelope. Covers both the url_verification handshake and the
 * schema-2.0 event delivery. Fields are optional because the two shapes differ.
 */
export interface FeishuEventEnvelope {
	/** Schema version, "2.0" for events */
	schema?: string;
	/** Event metadata header (schema 2.0) */
	header?: FeishuEventHeader;
	/** Event body */
	event?: FeishuMessageReceiveEvent;
	/** Envelope type — "url_verification" for the handshake */
	type?: string;
	/** Challenge string (url_verification only) */
	challenge?: string;
	/** Verification token (url_verification, or v1 events) */
	token?: string;
}
