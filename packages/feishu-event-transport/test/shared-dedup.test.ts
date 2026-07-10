import { afterEach, describe, expect, it, vi } from "vitest";
import { EventDeduplicator } from "../src/EventDeduplicator.js";
import { FeishuEventTransport } from "../src/FeishuEventTransport.js";
import { FeishuWsClient } from "../src/FeishuWsClient.js";
import type {
	FeishuEventTransportConfig,
	FeishuWebhookEvent,
} from "../src/types.js";
import { BOT_OPEN_ID, testMentionEnvelope, USER_OPEN_ID } from "./fixtures.js";

// Mock the long-connection SDK so FeishuWsClient can be driven synchronously.
const sdk = vi.hoisted(() => ({
	handlers: {} as Record<string, (data: unknown) => unknown>,
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
	Domain: { Feishu: 0, Lark: 1 },
	LoggerLevel: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
	WSClient: class {
		start() {}
		close() {}
	},
	EventDispatcher: class {
		register(handles: Record<string, (data: unknown) => unknown>) {
			Object.assign(sdk.handlers, handles);
			return this;
		}
	},
}));

function createMockFastify() {
	const routes: Record<
		string,
		(request: unknown, reply: unknown) => Promise<void>
	> = {};
	return {
		post: vi.fn((path: string, ...args: unknown[]) => {
			const handler = (args.length === 1 ? args[0] : args[1]) as (
				request: unknown,
				reply: unknown,
			) => Promise<void>;
			routes[path] = handler;
		}),
		routes,
	};
}

function createMockReply() {
	return {
		code: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
	};
}

/**
 * A flattened im.message.receive_v1 payload as the SDK hands it to WS handlers,
 * carrying the SAME event_id as {@link testMentionEnvelope} so a shared
 * deduplicator can recognize the two as one logical event.
 */
function wsMirrorOfMention() {
	return {
		event_id: "evt_mention_1",
		tenant_key: "tenant_1",
		create_time: "1700000000000",
		sender: { sender_id: { open_id: USER_OPEN_ID }, sender_type: "user" },
		message: {
			message_id: "om_msg1",
			chat_id: "oc_chat1",
			chat_type: "group",
			message_type: "text",
			content: JSON.stringify({ text: "@_user_1 please fix the login bug" }),
			mentions: [
				{ key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "Cyrus" },
			],
		},
	};
}

describe("shared event_id deduplication across transports (IN-50)", () => {
	afterEach(() => {
		sdk.handlers = {};
		vi.clearAllMocks();
	});

	it("processes an event once when the webhook and long connection both deliver it", async () => {
		const dedup = new EventDeduplicator();

		const mockFastify = createMockFastify();
		const transportConfig: FeishuEventTransportConfig = {
			fastifyServer:
				mockFastify as unknown as FeishuEventTransportConfig["fastifyServer"],
			verificationMode: "direct",
			secret: "",
			verificationToken: "verif-token",
			getBotOpenId: () => BOT_OPEN_ID,
			deduplicator: dedup,
		};
		const transport = new FeishuEventTransport(transportConfig);
		transport.register();

		const wsClient = new FeishuWsClient({
			appId: "cli_app",
			appSecret: "secret",
			getBotOpenId: () => BOT_OPEN_ID,
			deduplicator: dedup,
		});
		wsClient.start();
		const wsHandler = sdk.handlers["im.message.receive_v1"];

		const transportEvents: FeishuWebhookEvent[] = [];
		const wsEvents: FeishuWebhookEvent[] = [];
		transport.on("event", (e) => transportEvents.push(e));
		wsClient.on("event", (e) => wsEvents.push(e));

		// 1) Webhook delivers first and claims the event_id.
		const reply = createMockReply();
		await mockFastify.routes["/feishu-webhook"](
			{
				body: testMentionEnvelope,
				rawBody: JSON.stringify(testMentionEnvelope),
			},
			reply,
		);

		// 2) The long connection redelivers the SAME event_id — it must be dropped.
		await wsHandler(wsMirrorOfMention());

		expect(transportEvents).toHaveLength(1);
		expect(wsEvents).toHaveLength(0);
		expect(transportEvents[0]!.eventId).toBe("evt_mention_1");
	});

	it("processes the event over the long connection when it arrives there first", async () => {
		const dedup = new EventDeduplicator();

		const mockFastify = createMockFastify();
		const transport = new FeishuEventTransport({
			fastifyServer:
				mockFastify as unknown as FeishuEventTransportConfig["fastifyServer"],
			verificationMode: "direct",
			secret: "",
			verificationToken: "verif-token",
			getBotOpenId: () => BOT_OPEN_ID,
			deduplicator: dedup,
		});
		transport.register();

		const wsClient = new FeishuWsClient({
			appId: "cli_app",
			appSecret: "secret",
			getBotOpenId: () => BOT_OPEN_ID,
			deduplicator: dedup,
		});
		wsClient.start();
		const wsHandler = sdk.handlers["im.message.receive_v1"];

		const transportEvents: FeishuWebhookEvent[] = [];
		const wsEvents: FeishuWebhookEvent[] = [];
		transport.on("event", (e) => transportEvents.push(e));
		wsClient.on("event", (e) => wsEvents.push(e));

		// Long connection wins the race this time.
		await wsHandler(wsMirrorOfMention());

		const reply = createMockReply();
		await mockFastify.routes["/feishu-webhook"](
			{
				body: testMentionEnvelope,
				rawBody: JSON.stringify(testMentionEnvelope),
			},
			reply,
		);

		expect(wsEvents).toHaveLength(1);
		expect(transportEvents).toHaveLength(0);
	});

	it("does NOT share state when each transport keeps its own deduplicator (legacy)", async () => {
		// Without a shared instance, the same event_id passes both filters — the
		// exact double-injection IN-50 fixes. This documents the contrast.
		const mockFastify = createMockFastify();
		const transport = new FeishuEventTransport({
			fastifyServer:
				mockFastify as unknown as FeishuEventTransportConfig["fastifyServer"],
			verificationMode: "direct",
			secret: "",
			verificationToken: "verif-token",
			getBotOpenId: () => BOT_OPEN_ID,
		});
		transport.register();

		const wsClient = new FeishuWsClient({
			appId: "cli_app",
			appSecret: "secret",
			getBotOpenId: () => BOT_OPEN_ID,
		});
		wsClient.start();
		const wsHandler = sdk.handlers["im.message.receive_v1"];

		const transportEvents: FeishuWebhookEvent[] = [];
		const wsEvents: FeishuWebhookEvent[] = [];
		transport.on("event", (e) => transportEvents.push(e));
		wsClient.on("event", (e) => wsEvents.push(e));

		const reply = createMockReply();
		await mockFastify.routes["/feishu-webhook"](
			{
				body: testMentionEnvelope,
				rawBody: JSON.stringify(testMentionEnvelope),
			},
			reply,
		);
		await wsHandler(wsMirrorOfMention());

		expect(transportEvents).toHaveLength(1);
		expect(wsEvents).toHaveLength(1);
	});
});
