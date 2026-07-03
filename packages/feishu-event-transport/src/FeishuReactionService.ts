/**
 * Service for adding reactions on Feishu (Lark) messages.
 *
 * Used to acknowledge receipt of an @mention (an "on it" reaction) and to signal
 * the agent finished its turn (a "done" reaction). Feishu keys reactions by a
 * fixed `emoji_type` string and returns a `reaction_id` on add; removal requires
 * that id, so callers that want to remove a reaction must retain it.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete
 */

import { FEISHU_DEFAULT_BASE_URL } from "./FeishuTokenProvider.js";

/**
 * Parameters for adding a reaction to a Feishu message.
 */
export interface FeishuAddReactionParams {
	/** Feishu tenant_access_token */
	token: string;
	/** ID of the message to react to (e.g. "om_...") */
	messageId: string;
	/** Feishu emoji_type key, e.g. "OnIt" or "DONE" */
	emojiType: string;
}

/**
 * Parameters for removing a reaction from a Feishu message.
 */
export interface FeishuRemoveReactionParams {
	/** Feishu tenant_access_token */
	token: string;
	/** ID of the message the reaction is on */
	messageId: string;
	/** The reaction_id returned by addReaction */
	reactionId: string;
}

export class FeishuReactionService {
	private readonly apiBaseUrl: string;

	constructor(apiBaseUrl?: string) {
		this.apiBaseUrl = (apiBaseUrl ?? FEISHU_DEFAULT_BASE_URL).replace(
			/\/+$/,
			"",
		);
	}

	/**
	 * Add a reaction to a Feishu message. Returns the created `reaction_id`
	 * (needed to remove it later), or undefined when Feishu did not return one.
	 *
	 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create
	 */
	async addReaction(
		params: FeishuAddReactionParams,
	): Promise<string | undefined> {
		const { token, messageId, emojiType } = params;
		const url = `${this.apiBaseUrl}/im/v1/messages/${encodeURIComponent(messageId)}/reactions`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[FeishuReactionService] addReaction failed: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		const body = (await response.json()) as {
			code: number;
			msg?: string;
			data?: { reaction_id?: string };
		};
		if (body.code !== 0) {
			throw new Error(
				`[FeishuReactionService] Feishu API error (addReaction): code=${body.code} msg=${body.msg ?? "unknown"}`,
			);
		}
		return body.data?.reaction_id;
	}

	/**
	 * Remove a reaction from a Feishu message by its reaction_id.
	 *
	 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete
	 */
	async removeReaction(params: FeishuRemoveReactionParams): Promise<void> {
		const { token, messageId, reactionId } = params;
		const url = `${this.apiBaseUrl}/im/v1/messages/${encodeURIComponent(
			messageId,
		)}/reactions/${encodeURIComponent(reactionId)}`;

		const response = await fetch(url, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[FeishuReactionService] removeReaction failed: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		const body = (await response.json()) as { code: number; msg?: string };
		if (body.code !== 0) {
			throw new Error(
				`[FeishuReactionService] Feishu API error (removeReaction): code=${body.code} msg=${body.msg ?? "unknown"}`,
			);
		}
	}
}
