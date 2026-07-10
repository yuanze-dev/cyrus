import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import type { SessionStartMessage, UserPromptMessage } from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock heavy dependencies so we can construct a real EdgeWorker and exercise
// the InternalMessage-bus handlers (IN-42 §5 P2) in isolation.
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
 * IN-42 §5 P2 — activation of the unified InternalMessage entry point.
 *
 * Verifies:
 *  - Shadow mode (default): the bus records channel↔session correlation but does
 *    NOT drive execution; the legacy `event` path stays the source of truth.
 *  - Active mode ("switch"): the bus consumes the raw webhook handed off by the
 *    legacy path and drives the exact same session-creation / prompt handling,
 *    while the legacy `handleWebhook` early-returns — so the runner starts once.
 *  - Parity snapshots (used for the shadow-mode comparison) reflect the
 *    correlation registry consistently.
 */
describe("EdgeWorker - Session message bus (IN-42 P2)", () => {
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
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		// Default to shadow mode; individual tests opt into active mode.
		delete process.env.CYRUS_BUS_SESSION_OWNERSHIP;

		vi.mocked(createCyrusToolsServer).mockImplementation(() => {
			return { server: {} } as any;
		});

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
			hasAgentRunner: vi.fn().mockReturnValue(false),
			getSession: vi.fn().mockReturnValue(null),
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			createResponseActivity: vi.fn().mockResolvedValue(undefined),
			requestSessionStop: vi.fn(),
			setActivitySink: vi.fn(),
			on: vi.fn(),
		};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

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
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			handlers: {},
		};

		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).repositories.set("test-repo", mockRepository);
		(edgeWorker as any).agentSessionManager = mockAgentSessionManager;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.CYRUS_BUS_SESSION_OWNERSHIP;
	});

	// ---------------------------------------------------------------------------
	// Fixtures
	// ---------------------------------------------------------------------------
	function createdWebhook(overrides: any = {}) {
		return {
			type: "AgentSessionEvent",
			action: "created",
			createdAt: new Date().toISOString(),
			organizationId: "test-workspace",
			agentSession: {
				id: "session-abc",
				issue: { id: "issue-1", identifier: "TEST-1", title: "Test Issue" },
				comment: { body: "This thread is for an agent session" },
			},
			...overrides,
		};
	}

	function promptedWebhook(overrides: any = {}) {
		return {
			type: "AgentSessionEvent",
			action: "prompted",
			createdAt: new Date().toISOString(),
			organizationId: "test-workspace",
			agentSession: {
				id: "session-abc",
				issue: { id: "issue-1", identifier: "TEST-1", title: "Test Issue" },
			},
			agentActivity: {
				content: { body: "please continue" },
				...overrides.agentActivity,
			},
			...overrides,
		};
	}

	function sessionStartMessage(
		overrides: Partial<SessionStartMessage> = {},
	): SessionStartMessage {
		return {
			id: "msg-1",
			source: "linear",
			action: "session_start",
			receivedAt: new Date().toISOString(),
			organizationId: "test-workspace",
			sessionKey: "session-abc",
			workItemId: "issue-1",
			workItemIdentifier: "TEST-1",
			initialPrompt: "desc",
			title: "Test Issue",
			platformData: {
				agentSession: { id: "session-abc" } as any,
				issue: {
					id: "issue-1",
					identifier: "TEST-1",
					title: "Test Issue",
				} as any,
				isMentionTriggered: false,
			},
			...overrides,
		} as SessionStartMessage;
	}

	function userPromptMessage(
		overrides: Partial<UserPromptMessage> = {},
	): UserPromptMessage {
		return {
			id: "msg-2",
			source: "linear",
			action: "user_prompt",
			receivedAt: new Date().toISOString(),
			organizationId: "test-workspace",
			sessionKey: "session-abc",
			workItemId: "issue-1",
			workItemIdentifier: "TEST-1",
			content: "please continue",
			platformData: {
				agentActivity: { id: "act-1" } as any,
				agentSession: { id: "session-abc" } as any,
			},
			...overrides,
		} as UserPromptMessage;
	}

	// ---------------------------------------------------------------------------
	// getBusOwnershipMode
	// ---------------------------------------------------------------------------
	describe("getBusOwnershipMode", () => {
		it("defaults to shadow when unset", () => {
			expect((edgeWorker as any).getBusOwnershipMode("linear")).toBe("shadow");
		});

		it("returns active for 'active'/'all'/'on'", () => {
			for (const v of ["active", "all", "on", "ACTIVE"]) {
				process.env.CYRUS_BUS_SESSION_OWNERSHIP = v;
				expect((edgeWorker as any).getBusOwnershipMode("linear")).toBe(
					"active",
				);
			}
		});

		it("supports a comma list of owned sources", () => {
			process.env.CYRUS_BUS_SESSION_OWNERSHIP = "linear,feishu";
			expect((edgeWorker as any).getBusOwnershipMode("linear")).toBe("active");
			expect((edgeWorker as any).getBusOwnershipMode("feishu")).toBe("active");
			expect((edgeWorker as any).getBusOwnershipMode("slack")).toBe("shadow");
		});

		it("treats 'off'/'shadow' as shadow", () => {
			process.env.CYRUS_BUS_SESSION_OWNERSHIP = "off";
			expect((edgeWorker as any).getBusOwnershipMode("linear")).toBe("shadow");
		});
	});

	// ---------------------------------------------------------------------------
	// Parity snapshots (side-effect free)
	// ---------------------------------------------------------------------------
	describe("parity snapshots", () => {
		it("session_start: no existing binding → will not reuse", () => {
			const parity = (edgeWorker as any).computeSessionStartParity(
				sessionStartMessage(),
			);
			expect(parity.resolvedSessionId).toBeUndefined();
			expect(parity.willReuseExistingSession).toBe(false);
		});

		it("session_start: existing binding → will reuse", () => {
			(edgeWorker as any).globalSessionRegistry.bind(
				"session-abc",
				"session-abc",
			);
			const parity = (edgeWorker as any).computeSessionStartParity(
				sessionStartMessage(),
			);
			expect(parity.resolvedSessionId).toBe("session-abc");
			expect(parity.willReuseExistingSession).toBe(true);
		});

		it("user_prompt: resolves via alias when primary key misses", () => {
			(edgeWorker as any).globalSessionRegistry.bind(
				"alias-key",
				"session-xyz",
			);
			const parity = (edgeWorker as any).computeUserPromptParity(
				userPromptMessage({
					sessionKey: "missing",
					sessionKeyAliases: ["alias-key"],
				}),
			);
			expect(parity.resolvedSessionId).toBe("session-xyz");
			expect(parity.willInjectIntoExistingSession).toBe(true);
		});
	});

	// ---------------------------------------------------------------------------
	// Shadow mode: bus records correlation but never drives execution
	// ---------------------------------------------------------------------------
	describe("shadow mode (default)", () => {
		it("session_start records correlation but does not delegate to legacy", async () => {
			const spy = vi
				.spyOn(edgeWorker as any, "handleAgentSessionCreatedWebhook")
				.mockResolvedValue(undefined);

			await (edgeWorker as any).handleMessage(sessionStartMessage());

			// Correlation recorded (shadowRecordChannelCorrelation): Linear's
			// authoritative session id is now resolvable from its sessionKey.
			expect(
				(edgeWorker as any).globalSessionRegistry.resolve("session-abc"),
			).toBe("session-abc");
			// Bus did NOT start a runner — legacy owns execution in shadow mode.
			expect(spy).not.toHaveBeenCalled();
		});

		it("legacy handleWebhook still drives session creation in shadow mode", async () => {
			const spy = vi
				.spyOn(edgeWorker as any, "handleAgentSessionCreatedWebhook")
				.mockResolvedValue(undefined);

			await (edgeWorker as any).handleWebhook(createdWebhook(), [
				mockRepository,
			]);

			expect(spy).toHaveBeenCalledTimes(1);
			// Nothing stashed for the bus to consume in shadow mode.
			expect((edgeWorker as any).pendingLifecycleWebhooks.size).toBe(0);
		});

		it("user_prompt does not delegate to legacy prompt handler in shadow mode", async () => {
			const spy = vi
				.spyOn(edgeWorker as any, "handleUserPromptedAgentActivity")
				.mockResolvedValue(undefined);

			await (edgeWorker as any).handleMessage(userPromptMessage());

			expect(spy).not.toHaveBeenCalled();
		});
	});

	// ---------------------------------------------------------------------------
	// Active mode ("switch"): bus owns, legacy early-returns, runner starts once
	// ---------------------------------------------------------------------------
	describe("active mode (switch)", () => {
		beforeEach(() => {
			process.env.CYRUS_BUS_SESSION_OWNERSHIP = "linear";
		});

		it("session created: legacy stashes + early-returns, bus drives it exactly once", async () => {
			const spy = vi
				.spyOn(edgeWorker as any, "handleAgentSessionCreatedWebhook")
				.mockResolvedValue(undefined);

			// 1) Legacy path: hands off (stashes) and early-returns — no double start.
			await (edgeWorker as any).handleWebhook(createdWebhook(), [
				mockRepository,
			]);
			expect(spy).not.toHaveBeenCalled();
			expect(
				(edgeWorker as any).pendingLifecycleWebhooks.has("session-abc"),
			).toBe(true);

			// 2) Bus path: consumes the stash and drives the real handler once.
			await (edgeWorker as any).handleMessage(sessionStartMessage());
			expect(spy).toHaveBeenCalledTimes(1);
			// Stash consumed.
			expect(
				(edgeWorker as any).pendingLifecycleWebhooks.has("session-abc"),
			).toBe(false);
		});

		it("non-stop prompt: legacy stashes, bus delegates to prompt handler once", async () => {
			const spy = vi
				.spyOn(edgeWorker as any, "handleUserPromptedAgentActivity")
				.mockResolvedValue(undefined);

			await (edgeWorker as any).handleWebhook(promptedWebhook(), [
				mockRepository,
			]);
			expect(spy).not.toHaveBeenCalled();
			expect(
				(edgeWorker as any).pendingLifecycleWebhooks.has("session-abc"),
			).toBe(true);

			await (edgeWorker as any).handleMessage(userPromptMessage());
			expect(spy).toHaveBeenCalledTimes(1);
		});

		it("stop signal is NEVER handed to the bus (bus stop handler is still a placeholder)", async () => {
			const spy = vi
				.spyOn(edgeWorker as any, "handleUserPromptedAgentActivity")
				.mockResolvedValue(undefined);

			await (edgeWorker as any).handleWebhook(
				promptedWebhook({
					agentActivity: { signal: "stop", content: { body: "stop" } },
				}),
				[mockRepository],
			);

			// Legacy still owns the stop signal → delegated, nothing stashed.
			expect(spy).toHaveBeenCalledTimes(1);
			expect((edgeWorker as any).pendingLifecycleWebhooks.size).toBe(0);
		});

		it("created webhook without an issue is not handed off (falls through to legacy)", async () => {
			const spy = vi
				.spyOn(edgeWorker as any, "handleAgentSessionCreatedWebhook")
				.mockResolvedValue(undefined);

			await (edgeWorker as any).handleWebhook(
				createdWebhook({ agentSession: { id: "session-abc" } }),
				[mockRepository],
			);

			expect(spy).toHaveBeenCalledTimes(1);
			expect((edgeWorker as any).pendingLifecycleWebhooks.size).toBe(0);
		});

		it("bus session_start without a stashed webhook does not throw and starts nothing", async () => {
			const spy = vi
				.spyOn(edgeWorker as any, "handleAgentSessionCreatedWebhook")
				.mockResolvedValue(undefined);

			await (edgeWorker as any).handleMessage(sessionStartMessage());

			expect(spy).not.toHaveBeenCalled();
		});
	});
});
