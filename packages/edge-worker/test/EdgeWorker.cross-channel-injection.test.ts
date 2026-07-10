import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Same isolation approach as EdgeWorker.session-message-bus.test.ts: mock the
// heavy deps so we can construct a real EdgeWorker and exercise the private
// cross-channel injection helpers (IN-42 §5 P3) directly.
vi.mock("fs/promises");
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});

/**
 * IN-42 §5 P3 — cross-channel injection (Feishu follow-up → Linear session).
 *
 * Covers the new EdgeWorker helpers that the Feishu ChatSessionHandler calls
 * once a thread resolves to a foreign (Linear) session:
 *  - authorizeFeishuInjection (红线 guard),
 *  - injectCrossChannelPrompt (serial queue + Linear-side trace + three-state
 *    injection via the shared handlePromptWithStreamingCheck).
 */
describe("EdgeWorker - Cross-channel injection (IN-42 P3)", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockAgentSessionManager: any;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
		labelPrompts: {},
		teamKeys: ["TEST"],
	} as RepositoryConfig;

	const linearSession = {
		id: "linear-sess-1",
		externalSessionId: "linear-sess-1",
		issueContext: {
			trackerId: "linear",
			issueId: "issue-1",
			issueIdentifier: "IN-99",
		},
		workspace: { path: "/test/workspaces/IN-99", isGitWorktree: true },
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		vi.mocked(createCyrusToolsServer).mockImplementation(
			() => ({ server: {} }) as any,
		);
		vi.mocked(ClaudeRunner).mockImplementation(function () {
			return {
				supportsStreamingInput: true,
				startStreaming: vi.fn().mockResolvedValue({ sessionId: "claude-1" }),
				stop: vi.fn(),
				isStreaming: vi.fn().mockReturnValue(false),
				isRunning: vi.fn().mockReturnValue(false),
			};
		} as any);

		mockAgentSessionManager = {
			getSession: vi.fn().mockReturnValue(linearSession),
			getAgentRunner: vi.fn().mockReturnValue(undefined),
			createThoughtActivity: vi.fn().mockResolvedValue(undefined),
			createResponseActivity: vi.fn().mockResolvedValue(undefined),
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			setActivitySink: vi.fn(),
			setActivityObserver: vi.fn(),
			on: vi.fn(),
		};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		} as any);

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);
		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return { register: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
		} as any);
		vi.mocked(LinearClient).mockImplementation(function () {
			return {
				users: { me: vi.fn().mockResolvedValue({ id: "u1", name: "User" }) },
			};
		} as any);

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: { "test-workspace": { linearToken: "test-token" } },
			handlers: {},
		} as EdgeWorkerConfig;

		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).repositories.set("test-repo", mockRepository);
		(edgeWorker as any).agentSessionManager = mockAgentSessionManager;
		(edgeWorker as any).sessionRepositories.set("linear-sess-1", "test-repo");
		// Record the Feishu→Linear origin binding (as agentSessionCreated would).
		(edgeWorker as any).feishuIssueNotifier.recordIssueBinding({
			issueIdentifier: "IN-99",
			chatId: "oc_origin",
			openId: "ou_alice",
			rootMessageId: "om_root",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function feishuEvent(chatId: string): any {
		return {
			eventId: "evt-1",
			payload: {
				chatId,
				user: "ou_alice",
				userName: "Alice",
				messageId: "om_msg",
			},
		};
	}

	// ---------------------------------------------------------------------------
	// authorizeFeishuInjection (红线)
	// ---------------------------------------------------------------------------
	describe("authorizeFeishuInjection", () => {
		it("allows an injection from the same chat that created the issue", () => {
			const ok = (edgeWorker as any).authorizeFeishuInjection(
				"linear-sess-1",
				feishuEvent("oc_origin"),
			);
			expect(ok).toBe(true);
		});

		it("denies an injection from a different chat (越权注入)", () => {
			const ok = (edgeWorker as any).authorizeFeishuInjection(
				"linear-sess-1",
				feishuEvent("oc_intruder"),
			);
			expect(ok).toBe(false);
		});

		it("denies when the session has no recorded Feishu origin binding", () => {
			(edgeWorker as any).feishuIssueNotifier.restore(undefined);
			const ok = (edgeWorker as any).authorizeFeishuInjection(
				"linear-sess-1",
				feishuEvent("oc_origin"),
			);
			expect(ok).toBe(false);
		});

		it("denies when the target session does not exist", () => {
			mockAgentSessionManager.getSession.mockReturnValue(undefined);
			const ok = (edgeWorker as any).authorizeFeishuInjection(
				"linear-sess-1",
				feishuEvent("oc_origin"),
			);
			expect(ok).toBe(false);
		});
	});

	// ---------------------------------------------------------------------------
	// injectCrossChannelPrompt
	// ---------------------------------------------------------------------------
	describe("injectCrossChannelPrompt", () => {
		it("posts a Linear-side trace then injects via the shared streaming/resume path (AC: timeline 留痕)", async () => {
			const streamingCheck = vi
				.spyOn(edgeWorker as any, "handlePromptWithStreamingCheck")
				.mockResolvedValue(true);
			const onInjected = vi.fn().mockResolvedValue(undefined);

			await (edgeWorker as any).injectCrossChannelPrompt({
				sessionId: "linear-sess-1",
				text: "also add a modulo method",
				source: "feishu",
				authorLabel: "Alice (ou_alice)",
				authorize: () => true,
				onInjected,
			});

			// Trace activity posted, and it names the source + author + text.
			expect(
				mockAgentSessionManager.createThoughtActivity,
			).toHaveBeenCalledTimes(1);
			const [traceSessionId, traceBody] =
				mockAgentSessionManager.createThoughtActivity.mock.calls[0];
			expect(traceSessionId).toBe("linear-sess-1");
			expect(traceBody).toContain("来自飞书");
			expect(traceBody).toContain("Alice (ou_alice)");
			expect(traceBody).toContain("also add a modulo method");

			// Injected through the exact Linear three-state entry point.
			expect(streamingCheck).toHaveBeenCalledTimes(1);
			const args = streamingCheck.mock.calls[0];
			expect(args[0]).toBe(linearSession); // session
			expect(args[1]).toBe(mockRepository); // repository
			expect(args[2]).toBe("linear-sess-1"); // sessionId
			expect(args[4]).toBe("also add a modulo method"); // promptBody
			expect(onInjected).toHaveBeenCalledWith("streamed");
		});

		it("reports a resume when the runner was not streaming (AC: --continue 续跑)", async () => {
			vi.spyOn(
				edgeWorker as any,
				"handlePromptWithStreamingCheck",
			).mockResolvedValue(false);
			const onInjected = vi.fn().mockResolvedValue(undefined);

			await (edgeWorker as any).injectCrossChannelPrompt({
				sessionId: "linear-sess-1",
				text: "resume please",
				source: "feishu",
				authorLabel: "Alice",
				authorize: () => true,
				onInjected,
			});

			expect(onInjected).toHaveBeenCalledWith("resumed");
		});

		it("does NOT inject, trace, or touch the runner when authorization fails (红线)", async () => {
			const streamingCheck = vi.spyOn(
				edgeWorker as any,
				"handlePromptWithStreamingCheck",
			);
			const onDenied = vi.fn().mockResolvedValue(undefined);

			await (edgeWorker as any).injectCrossChannelPrompt({
				sessionId: "linear-sess-1",
				text: "let me in",
				source: "feishu",
				authorLabel: "Mallory",
				authorize: () => false,
				onDenied,
			});

			expect(onDenied).toHaveBeenCalledTimes(1);
			expect(
				mockAgentSessionManager.createThoughtActivity,
			).not.toHaveBeenCalled();
			expect(streamingCheck).not.toHaveBeenCalled();
		});

		it("drops the injection when the target session vanished", async () => {
			mockAgentSessionManager.getSession.mockReturnValue(undefined);
			const streamingCheck = vi.spyOn(
				edgeWorker as any,
				"handlePromptWithStreamingCheck",
			);

			await (edgeWorker as any).injectCrossChannelPrompt({
				sessionId: "linear-sess-1",
				text: "hello?",
				source: "feishu",
				authorLabel: "Alice",
				authorize: () => true,
			});

			expect(streamingCheck).not.toHaveBeenCalled();
		});

		it("serializes concurrent injections into the same session (no overlapping turns)", async () => {
			const order: string[] = [];
			let resolveFirst!: () => void;
			const firstGate = new Promise<void>((r) => {
				resolveFirst = r;
			});
			let call = 0;
			vi.spyOn(
				edgeWorker as any,
				"handlePromptWithStreamingCheck",
			).mockImplementation(async () => {
				const id = ++call;
				order.push(`start:${id}`);
				if (id === 1) await firstGate;
				order.push(`end:${id}`);
				return true;
			});

			const p1 = (edgeWorker as any).injectCrossChannelPrompt({
				sessionId: "linear-sess-1",
				text: "first",
				source: "feishu",
				authorLabel: "Alice",
				authorize: () => true,
			});
			const p2 = (edgeWorker as any).injectCrossChannelPrompt({
				sessionId: "linear-sess-1",
				text: "second",
				source: "feishu",
				authorLabel: "Alice",
				authorize: () => true,
			});

			// Let the first injection work its way through its async prologue
			// (authorize → getSession → trace) until it reaches the gated call.
			for (let i = 0; i < 20 && order.length === 0; i++) {
				await Promise.resolve();
			}
			// Second injection must not have started while the first is in-flight.
			expect(order).toEqual(["start:1"]);

			resolveFirst();
			await Promise.all([p1, p2]);
			expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
		});
	});
});
