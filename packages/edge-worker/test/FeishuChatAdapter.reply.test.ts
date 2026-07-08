import {
	FeishuMessageService,
	type FeishuTokenProvider,
	type FeishuWebhookEvent,
} from "cyrus-feishu-event-transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import { FeishuChatAdapter } from "../src/FeishuChatAdapter.js";

type Any = any;

function staticProvider(): ChatRepositoryProvider {
	return {
		getRepositoryPaths: () => [],
		getDefaultRepository: () => undefined,
		getDefaultLinearWorkspaceId: () => undefined,
	} as unknown as ChatRepositoryProvider;
}

function tokenProvider(): FeishuTokenProvider {
	return {
		getTenantAccessToken: vi.fn().mockResolvedValue("t_test"),
		getCachedBotOpenId: vi.fn().mockReturnValue("ou_bot"),
		resolveBotOpenId: vi.fn().mockResolvedValue("ou_bot"),
	} as unknown as FeishuTokenProvider;
}

function mentionEvent(): FeishuWebhookEvent {
	return {
		eventType: "mention",
		eventId: "evt_1",
		tenantKey: "tenant",
		payload: {
			type: "mention",
			user: "ou_requester",
			userName: "Ada",
			text: "hi",
			rawContent: "",
			messageType: "text",
			messageId: "om_msg",
			chatId: "oc_chat",
			chatType: "group",
			rootId: "om_root",
			createTime: "1700000000000",
		},
	} as FeishuWebhookEvent;
}

function runnerWithSummary(text: string) {
	return {
		getMessages: vi.fn().mockReturnValue([
			{
				type: "assistant",
				message: { content: [{ type: "text", text }] },
			},
		]),
	} as Any;
}

describe("FeishuChatAdapter.postReply Markdown card", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts the agent summary as a Markdown interactive card", async () => {
		const replySpy = vi
			.spyOn(FeishuMessageService.prototype, "replyMessage")
			.mockResolvedValue(undefined);

		const adapter = new FeishuChatAdapter(
			staticProvider(),
			tokenProvider(),
			undefined,
		);
		await adapter.postReply(
			mentionEvent(),
			runnerWithSummary("**done** with a list:\n- one\n- two"),
		);

		expect(replySpy).toHaveBeenCalledTimes(1);
		expect(replySpy).toHaveBeenCalledWith({
			token: "t_test",
			messageId: "om_msg",
			text: "**done** with a list:\n- one\n- two",
			replyInThread: true,
			format: "markdown",
		});
	});

	it("falls back to a plain-text reply when the Markdown card send fails", async () => {
		const replySpy = vi
			.spyOn(FeishuMessageService.prototype, "replyMessage")
			.mockRejectedValueOnce(new Error("code=230001 bad card"))
			.mockResolvedValueOnce(undefined);

		const adapter = new FeishuChatAdapter(
			staticProvider(),
			tokenProvider(),
			undefined,
		);
		await adapter.postReply(mentionEvent(), runnerWithSummary("**hi**"));

		expect(replySpy).toHaveBeenCalledTimes(2);
		// First attempt: Markdown card.
		expect(replySpy.mock.calls[0][0]).toMatchObject({ format: "markdown" });
		// Fallback attempt: plain text (no markdown format).
		expect(replySpy.mock.calls[1][0]).toEqual({
			token: "t_test",
			messageId: "om_msg",
			text: "**hi**",
			replyInThread: true,
		});
	});

	it("does not reply at all when the agent emits the no-response sentinel", async () => {
		const replySpy = vi
			.spyOn(FeishuMessageService.prototype, "replyMessage")
			.mockResolvedValue(undefined);

		const adapter = new FeishuChatAdapter(
			staticProvider(),
			tokenProvider(),
			undefined,
		);
		await adapter.postReply(
			mentionEvent(),
			runnerWithSummary("<<NO_RESPONSE>>"),
		);

		expect(replySpy).not.toHaveBeenCalled();
	});
});
