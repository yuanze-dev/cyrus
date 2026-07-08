import { getReadOnlyTools } from "cyrus-claude-runner";
import {
	FeishuMessageService,
	FeishuReactionService,
	type FeishuTokenProvider,
	FeishuUserDirectory,
	type FeishuWebhookEvent,
} from "cyrus-feishu-event-transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import { ChatSessionHandler } from "../src/ChatSessionHandler.js";
import {
	FEISHU_NO_RESPONSE_SENTINEL,
	FeishuChatAdapter,
	PROCESSED_EMOJI,
	RECEIPT_EMOJI,
} from "../src/FeishuChatAdapter.js";
import type { RunnerConfigBuilder } from "../src/RunnerConfigBuilder.js";
import { TEST_CYRUS_CHAT } from "./test-dirs.js";

// biome-ignore lint/suspicious/noExplicitAny: test doubles
type Any = any;

function createMockRunnerConfigBuilder(): RunnerConfigBuilder {
	return {
		buildChatConfig: (input: Any) => ({
			workingDirectory: input.workspacePath,
			allowedTools: [
				...new Set([
					...getReadOnlyTools(),
					"Bash(git -C * pull)",
					"mcp__linear",
				]),
			],
			disallowedTools: [],
			allowedDirectories: [input.workspacePath],
			workspaceName: input.workspaceName,
			cyrusHome: input.cyrusHome,
			appendSystemPrompt: input.systemPrompt,
			...(input.resumeSessionId
				? { resumeSessionId: input.resumeSessionId }
				: {}),
			logger: input.logger,
			maxTurns: 200,
			onMessage: input.onMessage,
			onError: input.onError,
		}),
		buildIssueConfig: vi.fn(),
	} as unknown as RunnerConfigBuilder;
}

function createStaticProvider(paths: string[] = []): ChatRepositoryProvider {
	return {
		getRepositoryPaths: () => paths,
		getDefaultRepository: () => undefined,
		getDefaultLinearWorkspaceId: () => undefined,
	};
}

function createMockTokenProvider(): FeishuTokenProvider {
	return {
		getTenantAccessToken: vi.fn().mockResolvedValue("t_test"),
		getCachedBotOpenId: vi.fn().mockReturnValue("ou_bot"),
		resolveBotOpenId: vi.fn().mockResolvedValue("ou_bot"),
	} as unknown as FeishuTokenProvider;
}

function mentionEvent(
	overrides: Partial<FeishuWebhookEvent["payload"]> = {},
	eventId = "evt_1",
): FeishuWebhookEvent {
	return {
		eventType: "mention",
		eventId,
		tenantKey: "tenant_1",
		payload: {
			type: "mention",
			user: "ou_user",
			text: "please build a feature",
			rawContent: JSON.stringify({ text: "@_user_1 please build a feature" }),
			messageType: "text",
			messageId: "om_1",
			chatId: "oc_chat",
			chatType: "group",
			createTime: "1700000000000",
			...overrides,
		},
	};
}

function fakeRunner(assistantText: string) {
	let captured: Any;
	const runner = {
		supportsStreamingInput: false,
		start: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
		stop: vi.fn(),
		isRunning: vi.fn().mockReturnValue(false),
		isStreaming: vi.fn().mockReturnValue(false),
		addStreamMessage: vi.fn(),
		getMessages: vi.fn().mockReturnValue([
			{
				type: "assistant",
				message: { content: [{ type: "text", text: assistantText }] },
			},
		]),
	};
	const createRunner = vi.fn((config: Any) => {
		captured = config;
		return runner as Any;
	});
	return { createRunner, getConfig: () => captured, runner };
}

function buildHandler(
	adapter: FeishuChatAdapter,
	createRunner: ReturnType<typeof fakeRunner>["createRunner"],
) {
	return new ChatSessionHandler<FeishuWebhookEvent>(adapter, {
		cyrusHome: TEST_CYRUS_CHAT,
		chatRepositoryProvider: createStaticProvider(),
		runnerConfigBuilder: createMockRunnerConfigBuilder(),
		createRunner,
		onWebhookStart: vi.fn(),
		onWebhookEnd: vi.fn(),
		onStateChange: vi.fn().mockResolvedValue(undefined),
		onClaudeError: vi.fn(),
	});
}

describe("FeishuChatAdapter integration with ChatSessionHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("derives a stable thread key from chat + thread root", () => {
		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);
		// A first @mention roots the thread at its own message id...
		expect(adapter.getThreadKey(mentionEvent())).toBe("oc_chat:om_1");
		// ...and a follow-up carrying that root maps to the same key.
		expect(
			adapter.getThreadKey(
				mentionEvent({ messageId: "om_2", rootId: "om_1" }, "evt_2"),
			),
		).toBe("oc_chat:om_1");
	});

	it("only lets @mentions (or upstream-gated events) start a session", () => {
		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);
		expect(adapter.isSessionInitiatingEvent(mentionEvent())).toBe(true);
		const plain = mentionEvent({ type: "message" });
		plain.eventType = "message";
		expect(adapter.isSessionInitiatingEvent(plain)).toBe(false);
	});

	it("system prompt frames Feishu and carries the Linear-issue orchestration", () => {
		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);
		const prompt = adapter.buildSystemPrompt(mentionEvent());
		expect(prompt).toContain("Feishu");
		expect(prompt).toContain("mcp__linear__save_issue");
		expect(prompt).toContain(FEISHU_NO_RESPONSE_SENTINEL);
	});

	it("system prompt shows the bare open_id as Requested by when no name resolved", () => {
		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);
		const prompt = adapter.buildSystemPrompt(mentionEvent());
		expect(prompt).toContain("**Requested by**: ou_user");
	});

	it("system prompt shows 'Name (open_id)' as Requested by when a name is present", () => {
		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);
		const prompt = adapter.buildSystemPrompt(
			mentionEvent({ userName: "Alice Wang" }),
		);
		expect(prompt).toContain("**Requested by**: Alice Wang (ou_user)");
	});

	it("default (non-full-access) system prompt frames the session as read-only", () => {
		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);
		const prompt = adapter.buildSystemPrompt(mentionEvent());
		expect(prompt).toContain("transient workspace");
		expect(prompt).not.toContain("Execution Environment (Full Access)");
	});

	it("full-access system prompt tells the agent it has unrestricted host access", () => {
		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
			undefined,
			{ fullAccess: true },
		);
		const prompt = adapter.buildSystemPrompt(mentionEvent());
		expect(prompt).toContain("Execution Environment (Full Access)");
		expect(prompt).toContain("entire host filesystem");
		// It should NOT claim to be a read-only transient workspace anymore.
		expect(prompt).not.toContain("transient workspace, not associated");
		// Orchestration path stays available for real repo code changes.
		expect(prompt).toContain("mcp__linear__save_issue");
	});

	it("reply-to-message @mention pulls in the replied-to message as context", async () => {
		// B replies to A's message and @mentions the bot. The event carries
		// parent_id/root_id (A's message) but no thread_id, so the agent must
		// fetch A's content directly to know what "do what A said" refers to.
		const fetchMessage = vi
			.spyOn(FeishuMessageService.prototype, "fetchMessage")
			.mockResolvedValue({
				messageId: "om_A",
				senderId: "ou_author",
				senderType: "user",
				messageType: "text",
				text: "Please refactor the auth module",
				createTime: "1700000000000",
			});

		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);

		const context = await adapter.fetchThreadContext(
			mentionEvent({
				messageId: "om_B",
				parentId: "om_A",
				rootId: "om_A",
				text: "@Cyrus complete what this message asked",
			}),
		);

		expect(fetchMessage).toHaveBeenCalledWith({
			token: "t_test",
			messageId: "om_A",
		});
		// root_id === parent_id, so A is fetched exactly once.
		expect(fetchMessage).toHaveBeenCalledTimes(1);
		expect(context).toContain("<feishu_replied_to_context>");
		expect(context).toContain("Please refactor the auth module");
		expect(context).toContain("ou_author");
	});

	it("resolves the replied-to author's open_id to a name when a directory is wired", async () => {
		vi.spyOn(FeishuMessageService.prototype, "fetchMessage").mockResolvedValue({
			messageId: "om_A",
			senderId: "ou_author",
			senderType: "user",
			messageType: "text",
			text: "Please refactor the auth module",
			createTime: "1700000000000",
		});

		const userDirectory = new FeishuUserDirectory();
		vi.spyOn(userDirectory, "resolveNames").mockResolvedValue(
			new Map([["ou_author", "Grace Hopper"]]),
		);

		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
			undefined,
			{ userDirectory },
		);

		const context = await adapter.fetchThreadContext(
			mentionEvent({
				messageId: "om_B",
				parentId: "om_A",
				rootId: "om_A",
				text: "@Cyrus complete what this message asked",
			}),
		);

		expect(context).toContain("<author>Grace Hopper (ou_author)</author>");
	});

	it("falls back to the bare open_id author when no directory is wired", async () => {
		vi.spyOn(FeishuMessageService.prototype, "fetchMessage").mockResolvedValue({
			messageId: "om_A",
			senderId: "ou_author",
			senderType: "user",
			messageType: "text",
			text: "Please refactor the auth module",
			createTime: "1700000000000",
		});

		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);

		const context = await adapter.fetchThreadContext(
			mentionEvent({
				messageId: "om_B",
				parentId: "om_A",
				rootId: "om_A",
			}),
		);

		expect(context).toContain("<author>ou_author</author>");
	});

	it("plain @mention with no thread and no reply target fetches nothing", async () => {
		const fetchMessage = vi.spyOn(
			FeishuMessageService.prototype,
			"fetchMessage",
		);
		const fetchThread = vi.spyOn(
			FeishuMessageService.prototype,
			"fetchThreadMessages",
		);

		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);

		const context = await adapter.fetchThreadContext(mentionEvent());

		expect(context).toBe("");
		expect(fetchMessage).not.toHaveBeenCalled();
		expect(fetchThread).not.toHaveBeenCalled();
	});

	it("@mention creates a session and threads the agent's reply back to Feishu", async () => {
		const reply = vi
			.spyOn(FeishuMessageService.prototype, "replyMessage")
			.mockResolvedValue(undefined);
		vi.spyOn(FeishuReactionService.prototype, "addReaction").mockResolvedValue(
			"react_1",
		);
		vi.spyOn(
			FeishuReactionService.prototype,
			"removeReaction",
		).mockResolvedValue(undefined);

		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);
		const { createRunner, getConfig } = fakeRunner(
			"Created Linear issue ENG-42 and assigned it to you.",
		);
		const handler = buildHandler(adapter, createRunner);

		await handler.handleEvent(mentionEvent());

		expect(createRunner).toHaveBeenCalledTimes(1);
		expect(handler.listThreads()).toEqual([
			{ threadKey: "oc_chat:om_1", sessionId: "feishu-evt_1" },
		]);

		// Drive the SDK "result" that ends the turn → triggers postReply.
		await getConfig().onMessage({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
			session_id: "session-1",
		});
		await new Promise((resolve) => setImmediate(resolve));

		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply).toHaveBeenCalledWith({
			token: "t_test",
			messageId: "om_1",
			text: "Created Linear issue ENG-42 and assigned it to you.",
			replyInThread: true,
			format: "markdown",
		});
	});

	it("removes the OnIt (working) reaction and adds DONE once the turn ends", async () => {
		vi.spyOn(FeishuMessageService.prototype, "replyMessage").mockResolvedValue(
			undefined,
		);
		const addReaction = vi
			.spyOn(FeishuReactionService.prototype, "addReaction")
			.mockResolvedValue("react_onit");
		const removeReaction = vi
			.spyOn(FeishuReactionService.prototype, "removeReaction")
			.mockResolvedValue(undefined);

		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);
		const { createRunner, getConfig } = fakeRunner("all done");
		const handler = buildHandler(adapter, createRunner);

		await handler.handleEvent(mentionEvent());

		// Receipt reaction added, none removed yet.
		expect(addReaction).toHaveBeenCalledWith({
			token: "t_test",
			messageId: "om_1",
			emojiType: RECEIPT_EMOJI,
		});
		expect(removeReaction).not.toHaveBeenCalled();

		// End the turn → DONE reaction added and the OnIt reaction removed.
		await getConfig().onMessage({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
			session_id: "session-1",
		});
		await new Promise((resolve) => setImmediate(resolve));

		expect(addReaction).toHaveBeenCalledWith({
			token: "t_test",
			messageId: "om_1",
			emojiType: PROCESSED_EMOJI,
		});
		expect(removeReaction).toHaveBeenCalledTimes(1);
		expect(removeReaction).toHaveBeenCalledWith({
			token: "t_test",
			messageId: "om_1",
			reactionId: "react_onit",
		});
	});

	it("stays silent when the agent emits the no-response sentinel", async () => {
		const reply = vi
			.spyOn(FeishuMessageService.prototype, "replyMessage")
			.mockResolvedValue(undefined);
		vi.spyOn(FeishuReactionService.prototype, "addReaction").mockResolvedValue(
			"react_1",
		);
		vi.spyOn(
			FeishuReactionService.prototype,
			"removeReaction",
		).mockResolvedValue(undefined);

		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);
		const { createRunner, getConfig } = fakeRunner(
			`thinking... ${FEISHU_NO_RESPONSE_SENTINEL}`,
		);
		const handler = buildHandler(adapter, createRunner);

		await handler.handleEvent(mentionEvent());
		await getConfig().onMessage({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
			session_id: "session-1",
		});
		await new Promise((resolve) => setImmediate(resolve));

		expect(reply).not.toHaveBeenCalled();
	});

	it("ignores a plain non-initiating message for an unbound thread", async () => {
		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);
		const { createRunner } = fakeRunner("noop");
		const handler = buildHandler(adapter, createRunner);

		const plain = mentionEvent(
			{ type: "message", messageId: "om_x", threadId: "omt_x" },
			"evt_plain",
		);
		plain.eventType = "message";
		await handler.handleEvent(plain);

		expect(createRunner).not.toHaveBeenCalled();
		expect(handler.listThreads()).toHaveLength(0);
	});

	it("continues the same session for a topic-thread follow-up (thread_id set)", async () => {
		vi.spyOn(FeishuMessageService.prototype, "replyMessage").mockResolvedValue(
			undefined,
		);
		vi.spyOn(FeishuReactionService.prototype, "addReaction").mockResolvedValue(
			"react_1",
		);

		const adapter = new FeishuChatAdapter(
			createStaticProvider(),
			createMockTokenProvider(),
		);
		// A "running, streaming" runner so a follow-up is injected into the live
		// session rather than starting a new one.
		const runner = {
			supportsStreamingInput: true,
			startStreaming: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
			start: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
			stop: vi.fn(),
			isRunning: vi.fn().mockReturnValue(true),
			isStreaming: vi.fn().mockReturnValue(true),
			addStreamMessage: vi.fn(),
			getMessages: vi.fn().mockReturnValue([]),
		};
		const createRunner = vi.fn(() => runner as Any);
		const handler = buildHandler(adapter, createRunner);

		// 1) @mention that starts (or is posted at the head of) a topic: it carries
		//    a thread_id but NO root_id — it IS the topic root.
		await handler.handleEvent(
			mentionEvent({ messageId: "om_root", threadId: "omt_x" }, "evt_root"),
		);
		expect(createRunner).toHaveBeenCalledTimes(1);
		expect(handler.listThreads()).toEqual([
			{ threadKey: "oc_chat:om_root", sessionId: "feishu-evt_root" },
		]);

		// 2) In-topic follow-up reply: thread_id set AND root_id = the topic root's
		//    message id. It must map to the SAME session, not spawn a second one.
		const followUp = mentionEvent(
			{
				type: "message",
				messageId: "om_reply",
				rootId: "om_root",
				threadId: "omt_x",
				text: "and add tests too",
			},
			"evt_reply",
		);
		followUp.eventType = "message";
		await handler.handleEvent(followUp);

		// No new session/runner — the follow-up was injected into the live one.
		expect(createRunner).toHaveBeenCalledTimes(1);
		expect(handler.listThreads()).toHaveLength(1);
		expect(runner.addStreamMessage).toHaveBeenCalledWith("and add tests too");
	});
});
