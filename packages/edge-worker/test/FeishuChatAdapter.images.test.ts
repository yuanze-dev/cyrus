import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FeishuMessageService,
	type FeishuTokenProvider,
	type FeishuWebhookEvent,
} from "cyrus-feishu-event-transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import { FeishuChatAdapter } from "../src/FeishuChatAdapter.js";

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function staticProvider(): ChatRepositoryProvider {
	return {
		getRepositoryPaths: () => [],
		getDefaultRepository: () => undefined,
		getDefaultLinearWorkspaceId: () => undefined,
	} as unknown as ChatRepositoryProvider;
}

function tokenProvider(token: string | null = "t_test"): FeishuTokenProvider {
	return {
		getTenantAccessToken: vi
			.fn()
			.mockResolvedValue(token === null ? undefined : token),
		getCachedBotOpenId: vi.fn().mockReturnValue("ou_bot"),
	} as unknown as FeishuTokenProvider;
}

function imageEvent(
	rawContent: string,
	messageType = "image",
): FeishuWebhookEvent {
	return {
		eventType: "mention",
		eventId: "evt_img",
		tenantKey: "tenant",
		payload: {
			type: "mention",
			user: "ou_requester",
			text: "",
			rawContent,
			messageType,
			messageId: "om_msg",
			chatId: "oc_chat",
			chatType: "group",
			rootId: "om_root",
			createTime: "1700000000000",
		},
	} as FeishuWebhookEvent;
}

function makeAdapter(cyrusHome: string, token: string | null = "t_test") {
	return new FeishuChatAdapter(
		staticProvider(),
		tokenProvider(token),
		undefined,
		{
			cyrusHome,
		},
	);
}

describe("FeishuChatAdapter.extractTaskInstructions image handling", () => {
	const homes: string[] = [];
	function tempHome(): string {
		const dir = mkdtempSync(join(tmpdir(), "feishu-img-"));
		homes.push(dir);
		return dir;
	}

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of homes.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("downloads an image message and appends a manifest with the local path", async () => {
		const home = tempHome();
		const downloadSpy = vi
			.spyOn(FeishuMessageService.prototype, "downloadMessageResource")
			.mockResolvedValue({ buffer: PNG_BYTES, contentType: "image/png" });

		const adapter = makeAdapter(home);
		const { text: prompt } = await adapter.extractTaskInstructions(
			imageEvent(JSON.stringify({ image_key: "img_v2_abc" })),
		);

		expect(downloadSpy).toHaveBeenCalledWith({
			token: "t_test",
			messageId: "om_msg",
			fileKey: "img_v2_abc",
		});
		expect(prompt).toContain("<feishu_attached_images>");
		expect(prompt).toContain("included 1 image");
		expect(prompt).toContain(".png");

		// File was actually written under the per-thread attachments dir.
		const dir = join(home, "feishu-attachments", "oc_chat_om_root");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^om_msg_1\.png$/);
	});

	it("combines post text with an image manifest (图文混排)", async () => {
		const home = tempHome();
		vi.spyOn(
			FeishuMessageService.prototype,
			"downloadMessageResource",
		).mockResolvedValue({ buffer: PNG_BYTES, contentType: "image/png" });

		const post = {
			content: [
				[
					{ tag: "text", text: "look at this" },
					{ tag: "img", image_key: "img_1" },
				],
			],
		};
		const adapter = makeAdapter(home);
		const { text: prompt } = await adapter.extractTaskInstructions(
			imageEvent(JSON.stringify(post), "post"),
		);

		expect(prompt.startsWith("look at this")).toBe(true);
		expect(prompt).toContain("<feishu_attached_images>");
	});

	it("degrades to a readable note when the download fails (no crash)", async () => {
		const home = tempHome();
		vi.spyOn(
			FeishuMessageService.prototype,
			"downloadMessageResource",
		).mockRejectedValue(new Error("403 no permission"));

		const adapter = makeAdapter(home);
		const { text: prompt } = await adapter.extractTaskInstructions(
			imageEvent(JSON.stringify({ image_key: "img_bad" })),
		);

		expect(prompt).toContain("could not be downloaded");
		expect(prompt).toContain("permission");
	});

	it("degrades to a note when no token is available", async () => {
		const home = tempHome();
		const downloadSpy = vi.spyOn(
			FeishuMessageService.prototype,
			"downloadMessageResource",
		);

		const adapter = makeAdapter(home, null);
		const { text: prompt } = await adapter.extractTaskInstructions(
			imageEvent(JSON.stringify({ image_key: "img_x" })),
		);

		expect(downloadSpy).not.toHaveBeenCalled();
		expect(prompt).toContain("could not be downloaded");
	});

	it("returns plain text (no image section) for a text-only message", async () => {
		const home = tempHome();
		const adapter = makeAdapter(home);
		const { text: prompt } = await adapter.extractTaskInstructions(
			imageEvent(JSON.stringify({ text: "just text" }), "text"),
		);

		expect(prompt).toBe("just text");
		expect(prompt).not.toContain("<feishu_attached_images>");
	});
});
