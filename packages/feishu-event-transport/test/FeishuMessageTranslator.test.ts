import type {
	FeishuSessionStartPlatformData,
	FeishuUserPromptPlatformData,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	buildPromptText,
	decodeFeishuContent,
	FeishuMessageTranslator,
	feishuThreadRoot,
	stripMention,
} from "../src/FeishuMessageTranslator.js";
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
	it("prefers rootId, then messageId — never threadId", () => {
		// A reply keys on its root_id (the conversation root message id).
		expect(
			feishuThreadRoot({
				...testMessageWebhookEvent.payload,
				rootId: "om_root",
				threadId: "omt_x",
				messageId: "om_msg",
			}),
		).toBe("om_root");
		// The root message itself has no root_id → keys on its own message id.
		expect(
			feishuThreadRoot({
				...testMentionWebhookEvent.payload,
				rootId: undefined,
				threadId: undefined,
				messageId: "om_only",
			}),
		).toBe("om_only");
		// Regression: a topic-root @mention (thread_id present, no root_id) must
		// key on messageId — NOT threadId — so it matches its follow-up replies
		// (whose root_id equals this message id).
		expect(
			feishuThreadRoot({
				...testMentionWebhookEvent.payload,
				rootId: undefined,
				threadId: "omt_x",
				messageId: "om_topic_root",
			}),
		).toBe("om_topic_root");
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

		it("maps a plain message to a UserPromptMessage keyed on the thread root", () => {
			const result = translator.translate(testMessageWebhookEvent);
			expect(result.success).toBe(true);
			if (!result.success) return;
			const msg = result.message;
			expect(msg.action).toBe("user_prompt");
			// rootId om_msg1 groups the follow-up with the originating mention
			expect(msg.sessionKey).toBe("oc_chat1:om_msg1");
			if (msg.action !== "user_prompt") return;
			expect(msg.content).toBe("also add a logout button");
			const data = msg.platformData as FeishuUserPromptPlatformData;
			expect(data.thread.rootId).toBe("om_msg1");
		});

		it("translateAsUserPrompt forces a user_prompt even for a mention", () => {
			const result = translator.translateAsUserPrompt(testMentionWebhookEvent);
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.message.action).toBe("user_prompt");
		});
	});
});
