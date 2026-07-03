import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuEventTransport } from "../src/FeishuEventTransport.js";
import type {
	FeishuEventEnvelope,
	FeishuEventTransportConfig,
	FeishuWebhookEvent,
} from "../src/types.js";
import {
	BOT_OPEN_ID,
	testMentionEnvelope,
	testP2pEnvelope,
	testPlainGroupEnvelope,
	testThreadedMessageEnvelope,
	testUrlVerificationEnvelope,
} from "./fixtures.js";

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

function createMockRequest(
	body: unknown,
	headers: Record<string, string> = {},
	rawBodyOverride?: string,
) {
	const rawBody = rawBodyOverride ?? JSON.stringify(body);
	return { body, rawBody, headers };
}

function createMockReply() {
	return {
		code: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
	};
}

/** Feishu-style AES-256-CBC encryption of a plaintext object. */
function encryptFeishu(plaintext: string, encryptKey: string): string {
	const key = createHash("sha256").update(encryptKey).digest();
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-256-cbc", key, iv);
	const encrypted = Buffer.concat([
		cipher.update(Buffer.from(plaintext, "utf8")),
		cipher.final(),
	]);
	return Buffer.concat([iv, encrypted]).toString("base64");
}

function signFeishu(
	timestamp: string,
	nonce: string,
	encryptKey: string,
	rawBody: string,
): string {
	return createHash("sha256")
		.update(timestamp + nonce + encryptKey + rawBody)
		.digest("hex");
}

const VERIF_TOKEN = "verif-token";
const ENCRYPT_KEY = "test-encrypt-key-32chars-padding!";

describe("FeishuEventTransport", () => {
	let mockFastify: ReturnType<typeof createMockFastify>;

	function directConfig(
		overrides: Partial<FeishuEventTransportConfig> = {},
	): FeishuEventTransportConfig {
		return {
			fastifyServer:
				mockFastify as unknown as FeishuEventTransportConfig["fastifyServer"],
			verificationMode: "direct",
			secret: "",
			verificationToken: VERIF_TOKEN,
			getBotOpenId: () => BOT_OPEN_ID,
			...overrides,
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mockFastify = createMockFastify();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers POST /feishu-webhook with rawBody", () => {
		const transport = new FeishuEventTransport(directConfig());
		transport.register();
		expect(mockFastify.post).toHaveBeenCalledWith(
			"/feishu-webhook",
			expect.objectContaining({ config: { rawBody: true } }),
			expect.any(Function),
		);
	});

	describe("url_verification", () => {
		it("responds with the challenge when the token matches", async () => {
			const transport = new FeishuEventTransport(directConfig());
			transport.register();
			const reply = createMockReply();
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(testUrlVerificationEnvelope),
				reply,
			);
			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({
				challenge: "challenge-abc-123",
			});
		});

		it("rejects a challenge with a mismatched token", async () => {
			const transport = new FeishuEventTransport(directConfig());
			transport.register();
			const reply = createMockReply();
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest({
					...testUrlVerificationEnvelope,
					token: "wrong",
				}),
				reply,
			);
			expect(reply.code).toHaveBeenCalledWith(401);
		});
	});

	describe("mention classification + emission (direct plaintext)", () => {
		it("emits a mention event and a translated message", async () => {
			const transport = new FeishuEventTransport(directConfig());
			transport.register();
			const eventListener = vi.fn();
			const messageListener = vi.fn();
			transport.on("event", eventListener);
			transport.on("message", messageListener);

			const reply = createMockReply();
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(testMentionEnvelope),
				reply,
			);

			expect(eventListener).toHaveBeenCalledTimes(1);
			const emitted = eventListener.mock.calls[0][0] as FeishuWebhookEvent;
			expect(emitted.eventType).toBe("mention");
			expect(emitted.payload.chatId).toBe("oc_chat1");
			expect(emitted.payload.messageId).toBe("om_msg1");
			expect(emitted.payload.text).toBe("@Cyrus please fix the login bug");
			expect(messageListener).toHaveBeenCalledTimes(1);
			expect(reply.code).toHaveBeenCalledWith(200);
		});

		it("classifies a p2p message as a mention even without @", async () => {
			const transport = new FeishuEventTransport(directConfig());
			transport.register();
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(testP2pEnvelope),
				createMockReply(),
			);
			expect(eventListener.mock.calls[0][0].eventType).toBe("mention");
		});

		it("classifies a threaded non-mention as a plain message", async () => {
			const transport = new FeishuEventTransport(directConfig());
			transport.register();
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(testThreadedMessageEnvelope),
				createMockReply(),
			);
			expect(eventListener).toHaveBeenCalledTimes(1);
			expect(eventListener.mock.calls[0][0].eventType).toBe("message");
		});

		it("drops a top-level (non-threaded) plain group message", async () => {
			const transport = new FeishuEventTransport(directConfig());
			transport.register();
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			const reply = createMockReply();
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(testPlainGroupEnvelope),
				reply,
			);
			expect(eventListener).not.toHaveBeenCalled();
			expect(reply.code).toHaveBeenCalledWith(200);
		});

		it("drops a threaded plain message when thread-following is disabled", async () => {
			const transport = new FeishuEventTransport(
				directConfig({ isThreadFollowingEnabled: () => false }),
			);
			transport.register();
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(testThreadedMessageEnvelope),
				createMockReply(),
			);
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("drops the bot's own (app-authored) messages", async () => {
			const transport = new FeishuEventTransport(directConfig());
			transport.register();
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			const envelope: FeishuEventEnvelope = {
				...testMentionEnvelope,
				event: {
					...testMentionEnvelope.event,
					sender: { sender_type: "app", sender_id: { open_id: BOT_OPEN_ID } },
				},
			};
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(envelope),
				createMockReply(),
			);
			expect(eventListener).not.toHaveBeenCalled();
		});
	});

	describe("de-duplication", () => {
		it("ignores a repeated event_id", async () => {
			const transport = new FeishuEventTransport(directConfig());
			transport.register();
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(testMentionEnvelope),
				createMockReply(),
			);
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(testMentionEnvelope),
				createMockReply(),
			);
			expect(eventListener).toHaveBeenCalledTimes(1);
		});
	});

	describe("token verification", () => {
		it("rejects an event whose header token mismatches", async () => {
			const transport = new FeishuEventTransport(directConfig());
			transport.register();
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			const envelope: FeishuEventEnvelope = {
				...testMentionEnvelope,
				header: { ...testMentionEnvelope.header!, token: "wrong" },
			};
			const reply = createMockReply();
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(envelope),
				reply,
			);
			expect(reply.code).toHaveBeenCalledWith(401);
			expect(eventListener).not.toHaveBeenCalled();
		});
	});

	describe("encrypted mode", () => {
		it("decrypts, verifies signature, and emits", async () => {
			const transport = new FeishuEventTransport(
				directConfig({ encryptKey: ENCRYPT_KEY }),
			);
			transport.register();
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const plaintext = JSON.stringify(testMentionEnvelope);
			const encrypt = encryptFeishu(plaintext, ENCRYPT_KEY);
			const outer = { encrypt };
			const rawBody = JSON.stringify(outer);
			const timestamp = "1700000000";
			const nonce = "nonce123";
			const signature = signFeishu(timestamp, nonce, ENCRYPT_KEY, rawBody);

			const reply = createMockReply();
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(
					outer,
					{
						"x-lark-signature": signature,
						"x-lark-request-timestamp": timestamp,
						"x-lark-request-nonce": nonce,
					},
					rawBody,
				),
				reply,
			);

			expect(eventListener).toHaveBeenCalledTimes(1);
			expect(eventListener.mock.calls[0][0].eventType).toBe("mention");
		});

		it("rejects a bad signature", async () => {
			const transport = new FeishuEventTransport(
				directConfig({ encryptKey: ENCRYPT_KEY }),
			);
			transport.register();
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const encrypt = encryptFeishu(
				JSON.stringify(testMentionEnvelope),
				ENCRYPT_KEY,
			);
			const outer = { encrypt };
			const rawBody = JSON.stringify(outer);
			const reply = createMockReply();
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(
					outer,
					{
						"x-lark-signature": "deadbeef".repeat(8),
						"x-lark-request-timestamp": "1700000000",
						"x-lark-request-nonce": "nonce123",
					},
					rawBody,
				),
				reply,
			);
			expect(reply.code).toHaveBeenCalledWith(401);
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("rejects an encrypted event when no encrypt key is configured", async () => {
			const transport = new FeishuEventTransport(directConfig());
			transport.register();
			const outer = { encrypt: "anything" };
			const reply = createMockReply();
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(outer, {}, JSON.stringify(outer)),
				reply,
			);
			expect(reply.code).toHaveBeenCalledWith(401);
		});
	});

	describe("non-message events", () => {
		it("ignores unsupported event types with 200", async () => {
			const transport = new FeishuEventTransport(directConfig());
			transport.register();
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			const reply = createMockReply();
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest({
					schema: "2.0",
					header: {
						...testMentionEnvelope.header,
						event_type: "im.chat.updated_v1",
					},
					event: {},
				}),
				reply,
			);
			expect(eventListener).not.toHaveBeenCalled();
			expect(reply.code).toHaveBeenCalledWith(200);
		});
	});

	describe("proxy mode", () => {
		it("accepts a valid Bearer token", async () => {
			const transport = new FeishuEventTransport({
				fastifyServer:
					mockFastify as unknown as FeishuEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: "proxy-secret",
				verificationToken: VERIF_TOKEN,
				getBotOpenId: () => BOT_OPEN_ID,
			});
			transport.register();
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			const reply = createMockReply();
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(testMentionEnvelope, {
					authorization: "Bearer proxy-secret",
				}),
				reply,
			);
			expect(eventListener).toHaveBeenCalledTimes(1);
			expect(eventListener.mock.calls[0][0].upstreamGated).toBe(true);
		});

		it("rejects a missing / wrong Bearer token", async () => {
			const transport = new FeishuEventTransport({
				fastifyServer:
					mockFastify as unknown as FeishuEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: "proxy-secret",
			});
			transport.register();
			const reply = createMockReply();
			await mockFastify.routes["/feishu-webhook"](
				createMockRequest(testMentionEnvelope, {
					authorization: "Bearer nope",
				}),
				reply,
			);
			expect(reply.code).toHaveBeenCalledWith(401);
		});
	});
});
