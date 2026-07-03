import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuTokenProvider } from "../src/FeishuTokenProvider.js";

function jsonResponse(body: unknown, ok = true) {
	return {
		ok,
		status: ok ? 200 : 500,
		statusText: ok ? "OK" : "Error",
		text: async () => JSON.stringify(body),
		json: async () => body,
	};
}

describe("FeishuTokenProvider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("mints and caches a tenant_access_token", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ code: 0, tenant_access_token: "t_123", expire: 7200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const provider = new FeishuTokenProvider({
			appId: "cli_app",
			appSecret: "secret",
		});
		const token1 = await provider.getTenantAccessToken();
		const token2 = await provider.getTenantAccessToken();

		expect(token1).toBe("t_123");
		expect(token2).toBe("t_123");
		// Cached — only one mint call
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			"https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
		);
		expect(JSON.parse(init.body)).toEqual({
			app_id: "cli_app",
			app_secret: "secret",
		});
	});

	it("throws on a non-zero mint code", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse({ code: 10003, msg: "bad app" })),
		);
		const provider = new FeishuTokenProvider({
			appId: "x",
			appSecret: "y",
		});
		await expect(provider.getTenantAccessToken()).rejects.toThrow(/code=10003/);
	});

	it("resolves and caches the bot open_id", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("tenant_access_token")) {
				return jsonResponse({
					code: 0,
					tenant_access_token: "t_1",
					expire: 7200,
				});
			}
			return jsonResponse({ code: 0, bot: { open_id: "ou_bot" } });
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = new FeishuTokenProvider({ appId: "a", appSecret: "b" });
		const id = await provider.resolveBotOpenId();
		expect(id).toBe("ou_bot");
		expect(provider.getCachedBotOpenId()).toBe("ou_bot");

		// Second resolution uses the cache (no additional bot/info fetch)
		const callsBefore = fetchMock.mock.calls.length;
		await provider.resolveBotOpenId();
		expect(fetchMock.mock.calls.length).toBe(callsBefore);
	});

	it("returns undefined bot open_id on failure without throwing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.includes("tenant_access_token")) {
					return jsonResponse({
						code: 0,
						tenant_access_token: "t_1",
						expire: 7200,
					});
				}
				return jsonResponse({}, false);
			}),
		);
		const provider = new FeishuTokenProvider({ appId: "a", appSecret: "b" });
		expect(await provider.resolveBotOpenId()).toBeUndefined();
	});
});
