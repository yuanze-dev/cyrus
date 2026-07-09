import type {
	FeishuSessionStartPlatformData,
	FeishuUserPromptPlatformData,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	buildPromptText,
	decodeFeishuContent,
	decodeFeishuImageKeys,
	extractFeishuImageKeys,
	FeishuMessageTranslator,
	feishuThreadRoot,
	feishuThreadRootCandidates,
	stripMention,
} from "../src/FeishuMessageTranslator.js";
import type { FeishuEventPayload } from "../src/types.js";
import {
	testMentionWebhookEvent,
	testMessageWebhookEvent,
} from "./fixtures.js";

describe("stripMention", () => {
	it("replaces named mention placeholders with @name and collapses whitespace", () => {
		expect(
			stripMention("@_user_1  do the thing", [
				{ key: "@_user_1", name: "Cyrus" },
			]),
		).toBe("@Cyrus do the thing");
	});

	it("removes unnamed placeholders", () => {
		expect(stripMention("@_user_1 hello", [{ key: "@_user_1" }])).toBe("hello");
	});

	it("strips leftover placeholder tokens not covered by mentions", () => {
		expect(stripMention("@_user_2 hi @_all", [])).toBe("hi");
	});
});

describe("decodeFeishuContent", () => {
	it("decodes a text message and strips the bot mention", () => {
		const text = decodeFeishuContent(
			"text",
			JSON.stringify({ text: "@_user_1 fix the bug" }),
			[{ key: "@_user_1", name: "Cyrus" }],
		);
		expect(text).toBe("@Cyrus fix the bug");
	});

	it("flattens a post (rich text) message", () => {
		const post = {
			title: "Project update",
			content: [
				[
					{ tag: "text", text: "See " },
					{ tag: "a", text: "the doc", href: "https://x.example" },
				],
				[
					{ tag: "at", user_name: "Alice" },
					{ tag: "text", text: " ping" },
				],
			],
		};
		const text = decodeFeishuContent("post", JSON.stringify(post));
		expect(text).toBe("Project update\nSee the doc\n@Alice ping");
	});

	it("decodes locale-keyed post content", () => {
		const post = {
			zh_cn: {
				title: "标题",
				content: [[{ tag: "text", text: "内容" }]],
			},
		};
		expect(decodeFeishuContent("post", JSON.stringify(post))).toBe(
			"标题\n内容",
		);
	});

	it("returns empty string for unsupported / unparseable content", () => {
		expect(decodeFeishuContent("image", "{not json")).toBe("");
		expect(decodeFeishuContent("text", "")).toBe("");
	});
});

describe("feishuThreadRoot", () => {
	it("prefers threadId, then rootId, then messageId", () => {
		// In a topic, thread_id is the stable identity across the whole topic.
		expect(
			feishuThreadRoot({
				...testMessageWebhookEvent.payload,
				rootId: "om_root",
				threadId: "omt_x",
				messageId: "om_msg",
			}),
		).toBe("omt_x");
		// No thread_id (plain reply) → keys on the conversation root message id.
		expect(
			feishuThreadRoot({
				...testMessageWebhookEvent.payload,
				rootId: "om_root",
				threadId: undefined,
				messageId: "om_msg",
			}),
		).toBe("om_root");
		// Neither thread_id nor root_id (a fresh @mention) → keys on its own id.
		expect(
			feishuThreadRoot({
				...testMentionWebhookEvent.payload,
				rootId: undefined,
				threadId: undefined,
				messageId: "om_only",
			}),
		).toBe("om_only");
	});
});

describe("feishuThreadRootCandidates", () => {
	it("orders thread_id → root_id → message_id and dedupes", () => {
		expect(
			feishuThreadRootCandidates({
				...testMessageWebhookEvent.payload,
				threadId: "omt_x",
				rootId: "om_root",
				messageId: "om_msg",
			}),
		).toEqual(["omt_x", "om_root", "om_msg"]);
	});

	it("omits absent identities, always keeping messageId", () => {
		// Fresh @mention: only its own message id.
		expect(
			feishuThreadRootCandidates({
				...testMentionWebhookEvent.payload,
				threadId: undefined,
				rootId: undefined,
				messageId: "om_only",
			}),
		).toEqual(["om_only"]);
		// Topic root @mention: thread_id then its own message id (no root_id).
		expect(
			feishuThreadRootCandidates({
				...testMentionWebhookEvent.payload,
				threadId: "omt_x",
				rootId: undefined,
				messageId: "om_topic_root",
			}),
		).toEqual(["omt_x", "om_topic_root"]);
	});

	it("dedupes when identities coincide", () => {
		// A reply whose root_id equals its own message id collapses to one key.
		expect(
			feishuThreadRootCandidates({
				...testMessageWebhookEvent.payload,
				threadId: undefined,
				rootId: "om_same",
				messageId: "om_same",
			}),
		).toEqual(["om_same"]);
	});
});

describe("buildPromptText", () => {
	it("returns the pre-decoded payload text when present", () => {
		expect(buildPromptText(testMentionWebhookEvent.payload)).toBe(
			"please fix the login bug",
		);
	});

	it("falls back to decoding rawContent when text is empty", () => {
		expect(
			buildPromptText({
				...testMentionWebhookEvent.payload,
				text: "",
				rawContent: JSON.stringify({ text: "@_user_1 raw fallback" }),
				mentions: [{ key: "@_user_1", name: "Cyrus" }],
			}),
		).toBe("@Cyrus raw fallback");
	});
});

describe("FeishuMessageTranslator", () => {
	const translator = new FeishuMessageTranslator();

	describe("canTranslate", () => {
		it("returns true for valid webhook events", () => {
			expect(translator.canTranslate(testMentionWebhookEvent)).toBe(true);
			expect(translator.canTranslate(testMessageWebhookEvent)).toBe(true);
		});
		it("returns false for null / non-object / missing fields", () => {
			expect(translator.canTranslate(null)).toBe(false);
			expect(translator.canTranslate("x")).toBe(false);
			const { eventType: _e, ...rest } = testMentionWebhookEvent;
			expect(translator.canTranslate(rest)).toBe(false);
		});
	});

	describe("translate", () => {
		it("maps a mention to a SessionStartMessage", () => {
			const result = translator.translate(testMentionWebhookEvent);
			expect(result.success).toBe(true);
			if (!result.success) return;
			const msg = result.message;
			expect(msg.source).toBe("feishu");
			expect(msg.action).toBe("session_start");
			expect(msg.sessionKey).toBe("oc_chat1:om_msg1");
			expect(msg.workItemIdentifier).toBe("feishu:oc_chat1:om_msg1");
			expect(msg.receivedAt).toBe(new Date(1700000000000).toISOString());
			if (msg.action !== "session_start") return;
			expect(msg.initialPrompt).toBe("please fix the login bug");
			const data = msg.platformData as FeishuSessionStartPlatformData;
			expect(data.chat.id).toBe("oc_chat1");
			expect(data.message.messageId).toBe("om_msg1");
			expect(data.tenantKey).toBe("tenant_1");
		});

		it("maps a plain message to a UserPromptMessage keyed on the thread id", () => {
			const result = translator.translate(testMessageWebhookEvent);
			expect(result.success).toBe(true);
			if (!result.success) return;
			const msg = result.message;
			expect(msg.action).toBe("user_prompt");
			// threadId omt_thread1 is the stable identity of the whole topic.
			expect(msg.sessionKey).toBe("oc_chat1:omt_thread1");
			if (msg.action !== "user_prompt") return;
			expect(msg.content).toBe("also add a logout button");
			const data = msg.platformData as FeishuUserPromptPlatformData;
			expect(data.thread.rootId).toBe("om_msg1");
			expect(data.thread.threadId).toBe("omt_thread1");
		});

		it("translateAsUserPrompt forces a user_prompt even for a mention", () => {
			const result = translator.translateAsUserPrompt(testMentionWebhookEvent);
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.message.action).toBe("user_prompt");
		});
	});
});

describe("decodeFeishuImageKeys", () => {
	it("extracts the image_key from an image message", () => {
		expect(
			decodeFeishuImageKeys(
				"image",
				JSON.stringify({ image_key: "img_v2_abc" }),
			),
		).toEqual(["img_v2_abc"]);
	});

	it("extracts inline img image_keys from a post message", () => {
		const post = {
			title: "look",
			content: [
				[
					{ tag: "text", text: "before " },
					{ tag: "img", image_key: "img_1" },
				],
				[{ tag: "img", image_key: "img_2" }],
			],
		};
		expect(decodeFeishuImageKeys("post", JSON.stringify(post))).toEqual([
			"img_1",
			"img_2",
		]);
	});

	it("extracts inline img keys from a locale-keyed post message", () => {
		const post = {
			zh_cn: {
				title: "看图",
				content: [[{ tag: "img", image_key: "img_zh" }]],
			},
		};
		expect(decodeFeishuImageKeys("post", JSON.stringify(post))).toEqual([
			"img_zh",
		]);
	});

	it("returns [] for text messages and unparseable content", () => {
		expect(
			decodeFeishuImageKeys("text", JSON.stringify({ text: "hi" })),
		).toEqual([]);
		expect(decodeFeishuImageKeys("image", "not json")).toEqual([]);
		expect(decodeFeishuImageKeys("image", "")).toEqual([]);
	});
});

describe("extractFeishuImageKeys", () => {
	const payload = (
		messageType: string,
		rawContent: string,
	): FeishuEventPayload => ({
		type: "mention",
		user: "ou_1",
		text: "",
		rawContent,
		messageType,
		messageId: "om_1",
		chatId: "oc_1",
		chatType: "group",
		createTime: "0",
	});

	it("dedupes repeated image keys, preserving first-seen order", () => {
		const post = {
			content: [
				[
					{ tag: "img", image_key: "img_a" },
					{ tag: "img", image_key: "img_b" },
				],
				[{ tag: "img", image_key: "img_a" }],
			],
		};
		expect(
			extractFeishuImageKeys(payload("post", JSON.stringify(post))),
		).toEqual(["img_a", "img_b"]);
	});

	it("returns [] for a text-only payload", () => {
		expect(
			extractFeishuImageKeys(
				payload("text", JSON.stringify({ text: "hello" })),
			),
		).toEqual([]);
	});
});
