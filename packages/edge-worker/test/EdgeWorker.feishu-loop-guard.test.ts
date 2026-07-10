import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { FeishuMessageService } from "cyrus-feishu-event-transport";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type {
	EdgeWorkerConfig,
	RepositoryConfig,
	UserAccessControlConfig,
} from "../src/types.js";
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
 * IN-50: the create-issue → backflow → re-ingest loop must not spin up a fresh
 * session, and Feishu chat users must be gate-able by open_id. Both hooks live in
 * EdgeWorker.handleFeishuEvent, so these tests drive that method directly against
 * a spied chat-session handler.
 */
describe("EdgeWorker - Feishu loop guard + open_id access control (IN-50)", () => {
	let edgeWorker: EdgeWorker;

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

	/** Build a minimal Feishu @mention event for chat oc_chat, thread root == messageId. */
	function feishuEvent(overrides: {
		text: string;
		openId?: string;
		messageId?: string;
	}): any {
		const messageId = overrides.messageId ?? "om_root";
		return {
			eventType: "mention",
			eventId: `evt_${messageId}_${overrides.text.length}`,
			tenantKey: "tenant_1",
			payload: {
				type: "mention",
				user: overrides.openId ?? "ou_requester",
				text: overrides.text,
				rawContent: JSON.stringify({ text: overrides.text }),
				messageType: "text",
				messageId,
				chatId: "oc_chat",
				chatType: "group",
				createTime: "1700000000000",
			},
		};
	}

	function buildWorker(userAccessControl?: UserAccessControlConfig) {
		const mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			userAccessControl,
			handlers: {},
		} as unknown as EdgeWorkerConfig;

		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).repositories.set("test-repo", mockRepository);
		(edgeWorker as any).feishuTokenProvider = {
			getTenantAccessToken: vi.fn().mockResolvedValue("t_test"),
		};
		// Spy on the chat handler: "started a session" == handleEvent was called.
		const handleEvent = vi.fn().mockResolvedValue(undefined);
		(edgeWorker as any).feishuChatSessionHandler = { handleEvent };
		return handleEvent;
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
				users: { me: vi.fn().mockResolvedValue({ id: "user-123", name: "T" }) },
			};
		} as any);
		vi.spyOn(FeishuMessageService.prototype, "replyMessage").mockResolvedValue(
			undefined,
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("loop idempotency", () => {
		it("drops a re-ingested backflow notice instead of starting a new session", async () => {
			const handleEvent = buildWorker();
			const noticeText = "✅ Done: created issue IN-42";

			// The runtime posts a completion notice into the thread (origin marking).
			await (edgeWorker as any).postFeishuThreadNotice({
				rootMessageId: "om_root",
				chatId: "oc_chat",
				text: noticeText,
			});

			// That exact notice is then re-ingested as an inbound event on the same
			// thread — it must be dropped, NOT handed to the session handler.
			await (edgeWorker as any).handleFeishuEvent(
				feishuEvent({ text: noticeText }),
			);

			expect(handleEvent).not.toHaveBeenCalled();
		});

		it("drops a duplicate inbound message within the window", async () => {
			const handleEvent = buildWorker();

			await (edgeWorker as any).handleFeishuEvent(
				feishuEvent({ text: "build the feature", messageId: "om_a" }),
			);
			await (edgeWorker as any).handleFeishuEvent(
				feishuEvent({ text: "build the feature", messageId: "om_a" }),
			);

			expect(handleEvent).toHaveBeenCalledTimes(1);
		});

		it("still processes a genuine new message in the same thread", async () => {
			const handleEvent = buildWorker();

			await (edgeWorker as any).postFeishuThreadNotice({
				rootMessageId: "om_root",
				chatId: "oc_chat",
				text: "a notice",
			});
			await (edgeWorker as any).handleFeishuEvent(
				feishuEvent({ text: "a different follow-up question" }),
			);

			expect(handleEvent).toHaveBeenCalledTimes(1);
		});
	});

	describe("open_id access control", () => {
		it("drops an event from a blocklisted open_id", async () => {
			const handleEvent = buildWorker({
				blockedUsers: [{ openId: "ou_blocked" }],
			});

			await (edgeWorker as any).handleFeishuEvent(
				feishuEvent({ text: "let me in", openId: "ou_blocked" }),
			);

			expect(handleEvent).not.toHaveBeenCalled();
		});

		it("processes an event from a non-blocked open_id", async () => {
			const handleEvent = buildWorker({
				blockedUsers: [{ openId: "ou_blocked" }],
			});

			await (edgeWorker as any).handleFeishuEvent(
				feishuEvent({ text: "let me in", openId: "ou_allowed" }),
			);

			expect(handleEvent).toHaveBeenCalledTimes(1);
		});

		it("drops an open_id that is not on the allowlist", async () => {
			const handleEvent = buildWorker({
				allowedUsers: [{ openId: "ou_vip" }],
			});

			await (edgeWorker as any).handleFeishuEvent(
				feishuEvent({ text: "hello", openId: "ou_random" }),
			);
			expect(handleEvent).not.toHaveBeenCalled();

			await (edgeWorker as any).handleFeishuEvent(
				feishuEvent({ text: "hello", openId: "ou_vip", messageId: "om_vip" }),
			);
			expect(handleEvent).toHaveBeenCalledTimes(1);
		});
	});
});
