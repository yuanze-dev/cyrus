import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuMessageService } from "../src/FeishuMessageService.js";

const BASE = "https://open.feishu.cn/open-apis";

function mockFetchOnce(body: unknown, ok = true, status = 200) {
	return vi.fn().mockResolvedValue({
		ok,
		status,
		statusText: ok ? "OK" : "Error",
		text: async () => JSON.stringify(body),
		json: async () => body,
	});
}

describe("FeishuMessageService", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("replyMessage posts to the /reply endpoint with a threaded text body", async () => {
		const fetchMock = mockFetchOnce({ code: 0, msg: "success" });
		vi.stubGlobal("fetch", fetchMock);

		await new FeishuMessageService().replyMessage({
			token: "t_abc",
			messageId: "om_1",
			text: "done ✅",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(`${BASE}/im/v1/messages/om_1/reply`);
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer t_abc");
		const payload = JSON.parse(init.body);
		expect(payload.msg_type).toBe("text");
		expect(payload.reply_in_thread).toBe(true);
		expect(JSON.parse(payload.content)).toEqual({ text: "done ✅" });
	});

	it("replyMessage with format 'markdown' posts an interactive card carrying the raw Markdown", async () => {
		const fetchMock = mockFetchOnce({ code: 0, msg: "success" });
		vi.stubGlobal("fetch", fetchMock);

		const markdown = "**bold**\n- item\n[link](https://example.com)\n`code`";
		await new FeishuMessageService().replyMessage({
			token: "t_abc",
			messageId: "om_1",
			text: markdown,
			format: "markdown",
		});

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(`${BASE}/im/v1/messages/om_1/reply`);
		const payload = JSON.parse(init.body);
		expect(payload.msg_type).toBe("interactive");
		expect(payload.reply_in_thread).toBe(true);
		const card = JSON.parse(payload.content);
		expect(card.schema).toBe("2.0");
		expect(card.body.elements).toEqual([
			{ tag: "markdown", content: markdown },
		]);
	});

	it("replyMessage defaults to a text body when no format is given", async () => {
		const fetchMock = mockFetchOnce({ code: 0 });
		vi.stubGlobal("fetch", fetchMock);

		await new FeishuMessageService().replyMessage({
			token: "t_abc",
			messageId: "om_1",
			text: "**not rendered**",
		});

		const [, init] = fetchMock.mock.calls[0];
		const payload = JSON.parse(init.body);
		expect(payload.msg_type).toBe("text");
		expect(JSON.parse(payload.content)).toEqual({ text: "**not rendered**" });
	});

	it("sendMessage posts to /im/v1/messages with receive_id_type", async () => {
		const fetchMock = mockFetchOnce({ code: 0 });
		vi.stubGlobal("fetch", fetchMock);

		await new FeishuMessageService().sendMessage({
			token: "t_abc",
			receiveId: "oc_chat",
			text: "hi",
		});

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(`${BASE}/im/v1/messages?receive_id_type=chat_id`);
		const payload = JSON.parse(init.body);
		expect(payload.receive_id).toBe("oc_chat");
		expect(JSON.parse(payload.content)).toEqual({ text: "hi" });
	});

	it("throws on a non-zero Feishu code (HTTP 200)", async () => {
		const fetchMock = mockFetchOnce({ code: 230001, msg: "bad token" });
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			new FeishuMessageService().replyMessage({
				token: "t",
				messageId: "om_1",
				text: "x",
			}),
		).rejects.toThrow(/code=230001/);
	});

	it("fetchMessage GETs a single message by id and decodes its text", async () => {
		const fetchMock = mockFetchOnce({
			code: 0,
			data: {
				items: [
					{
						message_id: "om_parent",
						msg_type: "text",
						create_time: "1700000000000",
						sender: { id: "ou_author", sender_type: "user" },
						body: { content: JSON.stringify({ text: "the original ask" }) },
					},
				],
			},
		});
		vi.stubGlobal("fetch", fetchMock);

		const message = await new FeishuMessageService().fetchMessage({
			token: "t_abc",
			messageId: "om_parent",
		});

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(`${BASE}/im/v1/messages/om_parent`);
		expect(init.method).toBe("GET");
		expect(init.headers.Authorization).toBe("Bearer t_abc");
		expect(message).toMatchObject({
			messageId: "om_parent",
			senderId: "ou_author",
			text: "the original ask",
		});
	});

	it("fetchMessage returns null when the message has no readable text", async () => {
		const fetchMock = mockFetchOnce({
			code: 0,
			data: {
				items: [
					{
						message_id: "om_img",
						msg_type: "image",
						body: { content: JSON.stringify({ image_key: "img_x" }) },
					},
				],
			},
		});
		vi.stubGlobal("fetch", fetchMock);

		const message = await new FeishuMessageService().fetchMessage({
			token: "t",
			messageId: "om_img",
		});
		expect(message).toBeNull();
	});

	it("fetchThreadMessages lists and decodes thread text", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({
				code: 0,
				data: {
					has_more: false,
					items: [
						{
							message_id: "om_a",
							msg_type: "text",
							create_time: "1700000000000",
							sender: { id: "ou_user", sender_type: "user" },
							body: { content: JSON.stringify({ text: "hello" }) },
						},
					],
				},
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const messages = await new FeishuMessageService().fetchThreadMessages({
			token: "t",
			threadId: "omt_1",
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			messageId: "om_a",
			senderId: "ou_user",
			text: "hello",
		});
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain("container_id_type=thread");
		expect(url).toContain("container_id=omt_1");
	});

	it("downloadMessageResource GETs the message resources endpoint and returns bytes + content type", async () => {
		const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: {
				get: (h: string) => (h === "content-type" ? "image/png" : null),
			},
			arrayBuffer: async () => bytes.buffer,
		});
		vi.stubGlobal("fetch", fetchMock);

		const resource = await new FeishuMessageService().downloadMessageResource({
			token: "t_img",
			messageId: "om_1",
			fileKey: "img_v2_abc",
		});

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			`${BASE}/im/v1/messages/om_1/resources/img_v2_abc?type=image`,
		);
		expect(init.method).toBe("GET");
		expect(init.headers.Authorization).toBe("Bearer t_img");
		expect(resource.contentType).toBe("image/png");
		expect(Array.from(resource.buffer)).toEqual([137, 80, 78, 71]);
	});

	it("downloadMessageResource throws with the error body on a non-ok response", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			statusText: "Forbidden",
			text: async () =>
				JSON.stringify({ code: 99991672, msg: "no permission" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			new FeishuMessageService().downloadMessageResource({
				token: "t",
				messageId: "om_1",
				fileKey: "img_x",
			}),
		).rejects.toThrow(/no permission/);
	});
});
