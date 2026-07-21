import { getReadOnlyTools } from "cyrus-claude-runner";
import type { ChannelBinding, SerializedCyrusAgentSession } from "cyrus-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import type {
	ChatPlatformAdapter,
	ChatSessionHandlerDeps,
} from "../src/ChatSessionHandler.js";
import { ChatSessionHandler } from "../src/ChatSessionHandler.js";
import { SessionCorrelationRegistry } from "../src/GlobalSessionRegistry.js";
import type { RunnerConfigBuilder } from "../src/RunnerConfigBuilder.js";
import { TEST_CYRUS_CHAT } from "./test-dirs.js";

type Any = any;

/**
 * Mock RunnerConfigBuilder that echoes the fields the resume assertion cares
 * about — importantly `resumeSessionId`, which is only set when the handler
 * takes the --continue path.
 */
function createMockRunnerConfigBuilder(): RunnerConfigBuilder {
	return {
		buildChatConfig: (input: Any) => ({
			workingDirectory: input.workspacePath,
			allowedTools: [
				...new Set([...getReadOnlyTools(), "Bash(git -C * pull)"]),
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

function createStaticProvider(): ChatRepositoryProvider {
	return {
		getRepositoryPaths: () => [],
		getDefaultRepository: () => undefined,
		getDefaultLinearWorkspaceId: () => undefined,
	};
}

function fakeRunnerFactory() {
	const configs: Any[] = [];
	const runner = {
		supportsStreamingInput: false,
		start: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
		stop: vi.fn(),
		isRunning: vi.fn().mockReturnValue(false),
		isStreaming: vi.fn().mockReturnValue(false),
		addStreamMessage: vi.fn(),
		getMessages: vi.fn().mockReturnValue([]),
	};
	const createRunner = vi.fn((config: Any) => {
		configs.push(config);
		return runner as Any;
	});
	return { createRunner, configs, runner };
}

interface SlackLikeEvent {
	eventId: string;
	channel: string;
	threadTs: string;
}

/**
 * Minimal chat adapter with a stable thread key and a slack channel binding —
 * enough to exercise create → persist → restore → resume.
 */
class TestSlackAdapter implements ChatPlatformAdapter<SlackLikeEvent> {
	public platformName = "slack" as const;

	extractTaskInstructions(_event: SlackLikeEvent): string {
		return "do the thing";
	}

	getThreadKey(event: SlackLikeEvent): string {
		return `${event.channel}:${event.threadTs}`;
	}

	getEventId(event: SlackLikeEvent): string {
		return event.eventId;
	}

	getChannelBinding(event: SlackLikeEvent): ChannelBinding {
		return { kind: "slack", channel: event.channel, threadTs: event.threadTs };
	}

	buildSystemPrompt(_event: SlackLikeEvent): string {
		return "system";
	}

	async fetchThreadContext(_event: SlackLikeEvent): Promise<string> {
		return "";
	}

	async postReply(): Promise<void> {}
	async acknowledgeReceipt(): Promise<void> {}
	async notifyBusy(): Promise<void> {}
}

function buildDeps(
	agentSessionManager: AgentSessionManager,
	correlationRegistry: SessionCorrelationRegistry,
	createRunner: ChatSessionHandlerDeps["createRunner"],
): ChatSessionHandlerDeps {
	return {
		cyrusHome: TEST_CYRUS_CHAT,
		agentSessionManager,
		correlationRegistry,
		chatRepositoryProvider: createStaticProvider(),
		runnerConfigBuilder: createMockRunnerConfigBuilder(),
		createRunner,
		onWebhookStart: vi.fn(),
		onWebhookEnd: vi.fn(),
		onStateChange: vi.fn().mockResolvedValue(undefined),
		onClaudeError: vi.fn(),
	};
}

/** Simulate a process restart by round-tripping ASM + registry through their
 * serialize/restore, exactly as EdgeWorker persistence does. */
function restart(
	asm: AgentSessionManager,
	registry: SessionCorrelationRegistry,
): { asm: AgentSessionManager; registry: SessionCorrelationRegistry } {
	const asmState = asm.serializeState();
	const registryState = registry.serializeState();

	const asm2 = new AgentSessionManager();
	asm2.restoreState(asmState.sessions, asmState.entries);
	// Rebuild the correlation registry the same way EdgeWorker.restoreMappings
	// does — directly from the serialized maps via setParentSession + bind.
	const registry2 = new SessionCorrelationRegistry();
	for (const [childId, parentId] of Object.entries(
		registryState.childToParentMap,
	)) {
		registry2.setParentSession(childId, parentId);
	}
	for (const [channelKey, sessionId] of Object.entries(
		registryState.sessionChannelIndex,
	)) {
		registry2.bind(channelKey, sessionId);
	}
	return { asm: asm2, registry: registry2 };
}

describe("ChatSessionHandler persistence (IN-42 §5 P1)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stores chat sessions in the injected singleton with a channel binding + correlation", async () => {
		const asm = new AgentSessionManager();
		const registry = new SessionCorrelationRegistry();
		const { createRunner } = fakeRunnerFactory();
		const handler = new ChatSessionHandler(
			new TestSlackAdapter(),
			buildDeps(asm, registry, createRunner),
		);

		await handler.handleEvent({
			eventId: "e1",
			channel: "C1",
			threadTs: "T1",
		});

		// Session lives in the shared singleton (not a private manager).
		const sessions = asm.getAllSessions();
		expect(sessions).toHaveLength(1);
		const session = sessions[0]!;
		expect(session.id).toBe("slack-e1");
		expect(session.channels).toEqual([
			{ kind: "slack", channel: "C1", threadTs: "T1" },
		]);

		// The thread key resolves to the session through the persisted registry.
		expect(registry.resolve("C1:T1")).toBe("slack-e1");
	});

	it("re-merges a follow-up on the same thread to the original session after a restart", async () => {
		const asm = new AgentSessionManager();
		const registry = new SessionCorrelationRegistry();
		const first = fakeRunnerFactory();
		const handler = new ChatSessionHandler(
			new TestSlackAdapter(),
			buildDeps(asm, registry, first.createRunner),
		);

		await handler.handleEvent({ eventId: "e1", channel: "C1", threadTs: "T1" });
		const originalId = asm.getAllSessions()[0]!.id;
		// Simulate the runner having initialized a Claude session (persisted so
		// --continue can resume it after restart).
		asm.getSession(originalId)!.claudeSessionId = "claude-xyz";

		// --- restart ---
		const restored = restart(asm, registry);

		// After restart the singleton has the session but no live runner.
		expect(restored.asm.getSession(originalId)).toBeDefined();
		expect(restored.asm.getAgentRunner(originalId)).toBeUndefined();

		const second = fakeRunnerFactory();
		const handler2 = new ChatSessionHandler(
			new TestSlackAdapter(),
			buildDeps(restored.asm, restored.registry, second.createRunner),
		);

		// Follow-up on the SAME thread, different event id.
		await handler2.handleEvent({
			eventId: "e2",
			channel: "C1",
			threadTs: "T1",
		});

		// No new session was created — the thread re-merged to the original.
		expect(restored.asm.getAllSessions()).toHaveLength(1);
		expect(restored.asm.getAllSessions()[0]!.id).toBe(originalId);

		// And it resumed via --continue using the persisted runner session id,
		// rather than starting a fresh session.
		expect(second.createRunner).toHaveBeenCalledTimes(1);
		expect(second.configs[0]!.resumeSessionId).toBe("claude-xyz");
	});

	it("scopes getAllChatSessions to sessions this handler owns (not the whole singleton)", async () => {
		const asm = new AgentSessionManager();
		const registry = new SessionCorrelationRegistry();
		const { createRunner } = fakeRunnerFactory();
		const handler = new ChatSessionHandler(
			new TestSlackAdapter(),
			buildDeps(asm, registry, createRunner),
		);

		// A foreign (e.g. Linear) session sharing the singleton must NOT leak out.
		asm.createChatSession("linear-uuid", { path: "/tmp/x" } as Any, "linear");

		await handler.handleEvent({ eventId: "e1", channel: "C1", threadTs: "T1" });

		const owned = handler.getAllChatSessions();
		expect(owned.map((s) => s.id)).toEqual(["slack-e1"]);
	});
});

describe("AgentSessionManager.restoreState channels[] backfill (IN-42 §5 P1)", () => {
	it("backfills a linear binding for an old Linear session lacking channels", () => {
		const asm = new AgentSessionManager();
		const legacy: SerializedCyrusAgentSession = {
			id: "sess-1",
			externalSessionId: "linear-agent-1",
			type: "commentThread" as Any,
			status: "active" as Any,
			context: "commentThread" as Any,
			createdAt: 1,
			updatedAt: 2,
			issueContext: {
				trackerId: "linear",
				issueId: "issue-123",
				issueIdentifier: "IN-9",
			},
			repositories: [],
			workspace: { path: "/tmp/ws", isGitWorktree: true },
		};

		asm.restoreState({ "sess-1": legacy }, { "sess-1": [] });

		expect(asm.getSession("sess-1")!.channels).toEqual([
			{
				kind: "linear",
				externalSessionId: "linear-agent-1",
				issueId: "issue-123",
				issueIdentifier: "IN-9",
			},
		]);
	});

	it("leaves channels absent for a session with no external session id", () => {
		const asm = new AgentSessionManager();
		const chatLike: SerializedCyrusAgentSession = {
			id: "sess-2",
			type: "commentThread" as Any,
			status: "active" as Any,
			context: "commentThread" as Any,
			createdAt: 1,
			updatedAt: 2,
			repositories: [],
			workspace: { path: "/tmp/ws2", isGitWorktree: false },
		};

		asm.restoreState({ "sess-2": chatLike }, { "sess-2": [] });

		expect(asm.getSession("sess-2")!.channels).toBeUndefined();
	});

	it("preserves an already-present channels array unchanged", () => {
		const asm = new AgentSessionManager();
		const channels: ChannelBinding[] = [
			{ kind: "feishu", chatId: "oc", threadRoot: "om", rootMessageId: "om" },
		];
		const withChannels = {
			id: "sess-3",
			externalSessionId: "linear-agent-3",
			type: "commentThread" as Any,
			status: "active" as Any,
			context: "commentThread" as Any,
			createdAt: 1,
			updatedAt: 2,
			issueContext: {
				trackerId: "linear",
				issueId: "issue-3",
				issueIdentifier: "IN-3",
			},
			repositories: [],
			workspace: { path: "/tmp/ws3", isGitWorktree: true },
			channels,
		} as unknown as SerializedCyrusAgentSession;

		asm.restoreState({ "sess-3": withChannels }, { "sess-3": [] });

		expect(asm.getSession("sess-3")!.channels).toEqual(channels);
	});
});
