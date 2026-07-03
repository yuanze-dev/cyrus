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
 * Parameters for replying to a Feishu message in its thread.
 */
export interface FeishuReplyMessageParams {
	/** Feishu tenant_access_token */
	token: string;
	/** ID of the message to reply to (e.g. "om_...") */
	messageId: string;
	/** Reply text */
	text: string;
	/** Whether to reply inside the thread (default true) */
	replyInThread?: boolean;
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
		const { token, messageId, text, replyInThread = true } = params;
		const url = `${this.apiBaseUrl}/im/v1/messages/${encodeURIComponent(messageId)}/reply`;

		await this.callApi("replyMessage", token, url, {
			msg_type: "text",
			content: JSON.stringify({ text }),
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
