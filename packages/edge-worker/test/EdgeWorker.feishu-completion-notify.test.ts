import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { FeishuMessageService } from "cyrus-feishu-event-transport";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

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
 * IN-10: A Linear issue created from a Feishu thread should notify that thread
 * when it is completed (Done). Exercises the wiring in
 * EdgeWorker.handleIssueStateChange → FeishuIssueNotificationService.
 */
describe("EdgeWorker - Feishu completion notify (IN-10)", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let replyMessage: ReturnType<typeof vi.spyOn>;

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
		teamKeys: ["IN"],
	};

	function stateChangeWebhook() {
		return {
			type: "Issue",
			action: "update",
			createdAt: new Date().toISOString(),
			organizationId: "test-workspace",
			data: {
				id: "issue-uuid",
				identifier: "IN-42",
				title: "Ship the thing",
				stateId: "state-completed",
			},
			updatedFrom: { stateId: "state-started" },
		};
	}

	function setIssueState(type: "completed" | "canceled") {
		const mockIssueTracker = {
			getClient: vi.fn().mockReturnValue({}),
			fetchIssue: vi.fn().mockResolvedValue({
				id: "issue-uuid",
				identifier: "IN-42",
				title: "Ship the thing",
				url: "https://linear.app/acme/issue/IN-42/ship-the-thing",
				state: Promise.resolve({ type }),
			}),
		};
		(edgeWorker as any).issueTrackers.set("test-workspace", mockIssueTracker);
	}

	function recordFeishuBinding() {
		(edgeWorker as any).feishuIssueNotifier.recordIssueBinding({
			issueIdentifier: "IN-42",
			issueId: "issue-uuid",
			issueTitle: "Ship the thing",
			issueUrl: "https://linear.app/acme/issue/IN-42/ship-the-thing",
			chatId: "oc_chat",
			openId: "ou_requester",
			userName: "Ada",
			rootMessageId: "om_root",
		});
	}

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
				stop: vi.fn(),
				isStreaming: vi.fn().mockReturnValue(false),
				isRunning: vi.fn().mockReturnValue(false),
			};
		} as any);
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return {
				getSessionsByIssueId: vi.fn().mockReturnValue([]),
				setActivityObserver: vi.fn(),
				serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
				on: vi.fn(),
			};
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
				users: {
					me: vi.fn().mockResolvedValue({ id: "user-123", name: "T" }),
				},
			};
		} as any);

		replyMessage = vi
			.spyOn(FeishuMessageService.prototype, "replyMessage")
			.mockResolvedValue(undefined);

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			handlers: {},
		} as unknown as EdgeWorkerConfig;

		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).repositories.set("test-repo", mockRepository);
		// A tenant token must be resolvable for the notice to be posted.
		(edgeWorker as any).feishuTokenProvider = {
			getTenantAccessToken: vi.fn().mockResolvedValue("t_test"),
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts an in-thread completion notice for a Feishu-created issue", async () => {
		recordFeishuBinding();
		setIssueState("completed");

		await (edgeWorker as any).handleIssueStateChange(stateChangeWebhook());

		expect(replyMessage).toHaveBeenCalledTimes(1);
		const call = replyMessage.mock.calls[0][0] as any;
		expect(call.messageId).toBe("om_root");
		expect(call.replyInThread).toBe(true);
		expect(call.text).toContain("Ship the thing");
		expect(call.text).toContain(
			"https://linear.app/acme/issue/IN-42/ship-the-thing",
		);
		expect(call.text).toContain("Ada");
	});

	it("does not notify when the issue was not created from Feishu", async () => {
		setIssueState("completed");

		await (edgeWorker as any).handleIssueStateChange(stateChangeWebhook());

		expect(replyMessage).not.toHaveBeenCalled();
	});

	it("does not notify when the issue was canceled (not completed)", async () => {
		recordFeishuBinding();
		setIssueState("canceled");

		await (edgeWorker as any).handleIssueStateChange(stateChangeWebhook());

		expect(replyMessage).not.toHaveBeenCalled();
	});

	it("is idempotent across repeated completion webhooks", async () => {
		recordFeishuBinding();
		setIssueState("completed");

		await (edgeWorker as any).handleIssueStateChange(stateChangeWebhook());
		await (edgeWorker as any).handleIssueStateChange(stateChangeWebhook());

		expect(replyMessage).toHaveBeenCalledTimes(1);
	});
});
