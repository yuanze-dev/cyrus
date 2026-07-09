import type {
	FeishuMention,
	FeishuTokenProvider,
	FeishuWebhookEvent,
} from "cyrus-feishu-event-transport";
import { describe, expect, it, vi } from "vitest";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import { FeishuChatAdapter } from "../src/FeishuChatAdapter.js";

const BOT_OPEN_ID = "ou_bot";

function staticProvider(): ChatRepositoryProvider {
	return {
		getRepositoryPaths: () => [],
		getDefaultRepository: () => undefined,
		getDefaultLinearWorkspaceId: () => undefined,
	} as unknown as ChatRepositoryProvider;
}

function tokenProvider(
	botOpenId: string | undefined = BOT_OPEN_ID,
): FeishuTokenProvider {
	return {
		getTenantAccessToken: vi.fn().mockResolvedValue("t_test"),
		getCachedBotOpenId: vi.fn().mockReturnValue(botOpenId),
	} as unknown as FeishuTokenProvider;
}

/**
 * Build a text webhook event. `renderedText` is the decoded `payload.text` the
 * adapter reads — i.e. what normalization (which runs without a botOpenId) would
 * have cached, with the bot self-mention already rendered as `@name`. `rawText`
 * backs `rawContent` for realism only.
 */
function textEvent(opts: {
	rawText: string;
	renderedText: string;
	mentions?: FeishuMention[];
	chatType?: string;
}): FeishuWebhookEvent {
	return {
		eventType: "mention",
		eventId: "evt_prefix",
		tenantKey: "tenant",
		payload: {
			type: "mention",
			user: "ou_user",
			text: opts.renderedText,
			rawContent: JSON.stringify({ text: opts.rawText }),
			messageType: "text",
			messageId: "om_msg",
			chatId: "oc_chat",
			chatType: opts.chatType ?? "group",
			rootId: "om_root",
			createTime: "1700000000000",
			mentions: opts.mentions,
		},
	} as FeishuWebhookEvent;
}

function makeAdapter(botOpenId: string | undefined = BOT_OPEN_ID) {
	return new FeishuChatAdapter(staticProvider(), tokenProvider(botOpenId));
}

const botMention: FeishuMention[] = [
	{ key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "Cyrus" },
];

describe("FeishuChatAdapter.extractTaskInstructions runner prefix routing", () => {
	it("routes a group message whose /codex prefix is preceded by the bot @mention", async () => {
		const adapter = makeAdapter();
		const result = await adapter.extractTaskInstructions(
			textEvent({
				rawText: "@_user_1 /codex 帮我x",
				renderedText: "@Cyrus /codex 帮我x",
				mentions: botMention,
			}),
		);
		expect(result.requestedRunnerType).toBe("codex");
		expect(result.text).toBe("帮我x");
	});

	it("is case-insensitive on the prefix after stripping the bot @mention", async () => {
		const adapter = makeAdapter();
		const result = await adapter.extractTaskInstructions(
			textEvent({
				rawText: "@_user_1 /Codex 帮我x",
				renderedText: "@Cyrus /Codex 帮我x",
				mentions: botMention,
			}),
		);
		expect(result.requestedRunnerType).toBe("codex");
		expect(result.text).toBe("帮我x");
	});

	it("strips a bot @mention whose display name contains spaces (matched by open_id)", async () => {
		const adapter = makeAdapter();
		const result = await adapter.extractTaskInstructions(
			textEvent({
				rawText: "@_user_1 /claude 帮我x",
				renderedText: "@张博 助手 /claude 帮我x",
				mentions: [
					{ key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "张博 助手" },
				],
			}),
		);
		expect(result.requestedRunnerType).toBe("claude");
		expect(result.text).toBe("帮我x");
	});

	it("routes a direct (p2p) /codex message with no @mention", async () => {
		const adapter = makeAdapter();
		const result = await adapter.extractTaskInstructions(
			textEvent({
				rawText: "/codex 帮我x",
				renderedText: "/codex 帮我x",
				chatType: "p2p",
			}),
		);
		expect(result.requestedRunnerType).toBe("codex");
		expect(result.text).toBe("帮我x");
	});

	it("does not route when /codex is not at the start (after the bot @mention)", async () => {
		const adapter = makeAdapter();
		const result = await adapter.extractTaskInstructions(
			textEvent({
				rawText: "@_user_1 帮我 /codex",
				renderedText: "@Cyrus 帮我 /codex",
				mentions: botMention,
			}),
		);
		expect(result.requestedRunnerType).toBeUndefined();
		expect(result.text).toBe("帮我 /codex");
	});

	it("leaves no @botName residue when the bot is @mentioned without a prefix", async () => {
		const adapter = makeAdapter();
		const result = await adapter.extractTaskInstructions(
			textEvent({
				rawText: "@_user_1 你好",
				renderedText: "@Cyrus 你好",
				mentions: botMention,
			}),
		);
		expect(result.requestedRunnerType).toBeUndefined();
		expect(result.text).toBe("你好");
	});
});
