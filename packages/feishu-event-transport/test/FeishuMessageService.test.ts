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
});
