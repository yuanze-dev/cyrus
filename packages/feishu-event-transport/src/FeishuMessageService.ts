/**
 * Service for posting messages to Feishu (Lark) chats.
 *
 * Uses the Feishu IM Open API with a `tenant_access_token` to send messages,
 * typically to reply to an @mention in a thread. Mirrors SlackMessageService,
 * but Feishu threads replies via the dedicated `/reply` endpoint (there is no
 * `thread_ts`-style field on the create endpoint).
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/reply
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/list
 */

import { FEISHU_DEFAULT_BASE_URL } from "./FeishuTokenProvider.js";

/**
 * A single message from a Feishu thread (im/v1/messages list).
 */
export interface FeishuThreadMessage {
	/** Message ID (e.g. "om_...") */
	messageId: string;
	/** Sender id (open_id when available) */
	senderId?: string;
	/** Sender type ("user" | "app") */
	senderType?: string;
	/** Decoded message text */
	text: string;
	/** Feishu message type ("text", "post", ...) */
	messageType: string;
	/** create_time (ms epoch string) */
	createTime?: string;
}

/**
 * How a message body is rendered in Feishu.
 *
 * - `text` (default): plain-text message (`msg_type: "text"`). Feishu does NOT
 *   render Markdown in text messages.
 * - `markdown`: an interactive card (`msg_type: "interactive"`, card schema 2.0)
 *   carrying a single `markdown` element, which renders a Markdown subset
 *   (bold/italic/strikethrough, lists, links, inline/fenced code, quotes,
 *   dividers). Use for agent replies that should render Markdown.
 */
export type FeishuMessageFormat = "text" | "markdown";

/**
 * Parameters for replying to a Feishu message in its thread.
 */
export interface FeishuReplyMessageParams {
	/** Feishu tenant_access_token */
	token: string;
	/** ID of the message to reply to (e.g. "om_...") */
	messageId: string;
	/** Reply text (plain text, or raw Markdown when `format: "markdown"`) */
	text: string;
	/** Whether to reply inside the thread (default true) */
	replyInThread?: boolean;
	/** How to render the body (default "text"). */
	format?: FeishuMessageFormat;
}

/**
 * Parameters for sending a new Feishu message.
 */
export interface FeishuSendMessageParams {
	/** Feishu tenant_access_token */
	token: string;
	/** Receiver id (chat_id, open_id, ...) */
	receiveId: string;
	/** Type of the receiver id (default "chat_id") */
	receiveIdType?: "chat_id" | "open_id" | "user_id" | "union_id" | "email";
	/** Message text */
	text: string;
}

/**
 * Parameters for fetching a single Feishu message by ID.
 */
export interface FeishuFetchMessageParams {
	/** Feishu tenant_access_token */
	token: string;
	/** ID of the message to fetch (e.g. "om_...") */
	messageId: string;
}

/**
 * Parameters for downloading an image/file resource attached to a Feishu
 * message.
 */
export interface FeishuDownloadResourceParams {
	/** Feishu tenant_access_token */
	token: string;
	/** ID of the message the resource is attached to (e.g. "om_...") */
	messageId: string;
	/** Resource key — for images this is the message's `image_key` */
	fileKey: string;
	/** Resource kind (default "image") */
	type?: "image" | "file";
}

/** A downloaded Feishu message resource (raw bytes + reported content type). */
export interface FeishuResource {
	/** Raw resource bytes */
	buffer: Buffer;
	/** `Content-Type` reported by Feishu, when present (e.g. "image/png") */
	contentType?: string;
}

/**
 * Parameters for listing messages in a Feishu thread.
 */
export interface FeishuFetchThreadParams {
	/** Feishu tenant_access_token */
	token: string;
	/** Thread ID (container_id when container_id_type=thread) */
	threadId: string;
	/** Maximum number of messages to fetch (default 50) */
	limit?: number;
}

/** Raw list-message item shape returned by Feishu. */
interface FeishuRawListMessage {
	message_id?: string;
	msg_type?: string;
	create_time?: string;
	sender?: { id?: string; sender_type?: string; id_type?: string };
	body?: { content?: string };
}

/** Decode a Feishu message `body.content` JSON string into plain text. */
function decodeListMessageText(
	msgType: string | undefined,
	content: string | undefined,
): string {
	if (!content) return "";
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		if (msgType === "text" && typeof parsed.text === "string") {
			return parsed.text;
		}
		if (typeof parsed.text === "string") return parsed.text;
		return "";
	} catch {
		return "";
	}
}

/**
 * Build a Feishu card (schema 2.0) that renders `markdown` as a single
 * `markdown` element. Feishu renders a Markdown subset in cards — bold, italic,
 * strikethrough, ordered/unordered lists, links, inline/fenced code, quotes and
 * dividers — which is enough to cover the common cases (tables and rich headers
 * are not supported).
 *
 * @see https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure
 */
export function buildMarkdownCard(markdown: string): Record<string, unknown> {
	return {
		schema: "2.0",
		body: {
			elements: [
				{
					tag: "markdown",
					content: markdown,
				},
			],
		},
	};
}

/**
 * Build the `{ msg_type, content }` pair for a Feishu message body. Text bodies
 * become `msg_type: "text"`; markdown bodies become an interactive card. The
 * `content` is always a JSON string (Feishu requires it stringified), which also
 * handles Markdown/JSON escaping of the text.
 */
function buildMessageBody(
	text: string,
	format: FeishuMessageFormat,
): { msg_type: string; content: string } {
	if (format === "markdown") {
		return {
			msg_type: "interactive",
			content: JSON.stringify(buildMarkdownCard(text)),
		};
	}
	return {
		msg_type: "text",
		content: JSON.stringify({ text }),
	};
}

export class FeishuMessageService {
	private readonly apiBaseUrl: string;

	constructor(apiBaseUrl?: string) {
		this.apiBaseUrl = (apiBaseUrl ?? FEISHU_DEFAULT_BASE_URL).replace(
			/\/+$/,
			"",
		);
	}

	/**
	 * Reply to a Feishu message, threading the reply under the original.
	 *
	 * @see https://open.feishu.cn/document/server-docs/im-v1/message/reply
	 */
	async replyMessage(params: FeishuReplyMessageParams): Promise<void> {
		const {
			token,
			messageId,
			text,
			replyInThread = true,
			format = "text",
		} = params;
		const url = `${this.apiBaseUrl}/im/v1/messages/${encodeURIComponent(messageId)}/reply`;

		await this.callApi("replyMessage", token, url, {
			...buildMessageBody(text, format),
			reply_in_thread: replyInThread,
		});
	}

	/**
	 * Send a new message to a Feishu chat/user.
	 *
	 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
	 */
	async sendMessage(params: FeishuSendMessageParams): Promise<void> {
		const { token, receiveId, receiveIdType = "chat_id", text } = params;
		const url = `${this.apiBaseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(
			receiveIdType,
		)}`;

		await this.callApi("sendMessage", token, url, {
			receive_id: receiveId,
			msg_type: "text",
			content: JSON.stringify({ text }),
		});
	}

	/**
	 * Fetch a single Feishu message by its ID — used to pull in the
	 * replied-to / parent message when a user replies to a specific message
	 * and @mentions the bot (a plain 回复 carries `parent_id`/`root_id` but no
	 * `thread_id`, so it can't be listed via {@link fetchThreadMessages}).
	 *
	 * Returns null when the message has no readable text (empty, non-text
	 * type, deleted, or not present in the response).
	 *
	 * @see https://open.feishu.cn/document/server-docs/im-v1/message/get
	 */
	async fetchMessage(
		params: FeishuFetchMessageParams,
	): Promise<FeishuThreadMessage | null> {
		const { token, messageId } = params;
		const url = `${this.apiBaseUrl}/im/v1/messages/${encodeURIComponent(messageId)}`;

		const response = await fetch(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[FeishuMessageService] Failed to fetch message ${messageId}: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		const body = (await response.json()) as {
			code: number;
			msg?: string;
			data?: { items?: FeishuRawListMessage[] };
		};

		if (body.code !== 0) {
			throw new Error(
				`[FeishuMessageService] Feishu API error (fetchMessage): code=${body.code} msg=${body.msg ?? "unknown"}`,
			);
		}

		const item = body.data?.items?.[0];
		if (!item) {
			return null;
		}

		const text = decodeListMessageText(item.msg_type, item.body?.content);
		if (!text) {
			return null;
		}

		return {
			messageId: item.message_id ?? messageId,
			senderId: item.sender?.id,
			senderType: item.sender?.sender_type,
			messageType: item.msg_type ?? "text",
			text,
			createTime: item.create_time,
		};
	}

	/**
	 * Download a resource (image/file) attached to a Feishu message, using the
	 * message-scoped resources endpoint. For images the `fileKey` is the
	 * message's `image_key`.
	 *
	 * Returns the raw bytes plus the reported `Content-Type`. Requires the app to
	 * hold the `im:resource` (message-resource read) permission; a permission or
	 * network failure throws so callers can degrade gracefully.
	 *
	 * @see https://open.feishu.cn/document/server-docs/im-v1/message/get-2
	 */
	async downloadMessageResource(
		params: FeishuDownloadResourceParams,
	): Promise<FeishuResource> {
		const { token, messageId, fileKey, type = "image" } = params;
		const url = `${this.apiBaseUrl}/im/v1/messages/${encodeURIComponent(
			messageId,
		)}/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(type)}`;

		const response = await fetch(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!response.ok) {
			// Feishu returns a JSON error body (code/msg) on failure even for this
			// binary endpoint; surface it so callers can log the reason.
			const errorBody = await response.text();
			throw new Error(
				`[FeishuMessageService] Failed to download resource ${fileKey} of message ${messageId}: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const contentType = response.headers.get("content-type") ?? undefined;
		return { buffer, contentType };
	}

	/**
	 * List messages in a Feishu thread using page-token pagination.
	 *
	 * @see https://open.feishu.cn/document/server-docs/im-v1/message/list
	 */
	async fetchThreadMessages(
		params: FeishuFetchThreadParams,
	): Promise<FeishuThreadMessage[]> {
		const { token, threadId, limit = 50 } = params;
		const messages: FeishuThreadMessage[] = [];
		let pageToken: string | undefined;

		while (messages.length < limit) {
			const query = new URLSearchParams({
				container_id_type: "thread",
				container_id: threadId,
				page_size: String(Math.min(limit - messages.length, 50)),
				sort_type: "ByCreateTimeAsc",
			});
			if (pageToken) {
				query.set("page_token", pageToken);
			}

			const url = `${this.apiBaseUrl}/im/v1/messages?${query.toString()}`;
			const response = await fetch(url, {
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
			});

			if (!response.ok) {
				const errorBody = await response.text();
				throw new Error(
					`[FeishuMessageService] Failed to fetch thread messages: ${response.status} ${response.statusText} - ${errorBody}`,
				);
			}

			const body = (await response.json()) as {
				code: number;
				msg?: string;
				data?: {
					items?: FeishuRawListMessage[];
					has_more?: boolean;
					page_token?: string;
				};
			};

			if (body.code !== 0) {
				throw new Error(
					`[FeishuMessageService] Feishu API error: code=${body.code} msg=${body.msg ?? "unknown"}`,
				);
			}

			for (const item of body.data?.items ?? []) {
				messages.push({
					messageId: item.message_id ?? "",
					senderId: item.sender?.id,
					senderType: item.sender?.sender_type,
					messageType: item.msg_type ?? "text",
					text: decodeListMessageText(item.msg_type, item.body?.content),
					createTime: item.create_time,
				});
			}

			const nextToken = body.data?.page_token;
			if (!body.data?.has_more || !nextToken) {
				break;
			}
			pageToken = nextToken;
		}

		return messages.slice(0, limit);
	}

	/**
	 * POST a JSON body to a Feishu endpoint and surface logical (`code !== 0`)
	 * errors — Feishu returns HTTP 200 with a non-zero `code` on failures.
	 */
	private async callApi(
		method: string,
		token: string,
		url: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[FeishuMessageService] ${method} failed: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		const body = (await response.json()) as { code: number; msg?: string };
		if (body.code !== 0) {
			throw new Error(
				`[FeishuMessageService] Feishu API error (${method}): code=${body.code} msg=${body.msg ?? "unknown"}`,
			);
		}
	}
}
