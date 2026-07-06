import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuUserDirectory } from "../src/FeishuUserDirectory.js";

function jsonResponse(body: unknown, ok = true) {
	return {
		ok,
		status: ok ? 200 : 500,
		statusText: ok ? "OK" : "Error",
		text: async () => JSON.stringify(body),
		json: async () => body,
	};
}

function usersResponse(items: Array<{ open_id: string; name: string }>) {
	return jsonResponse({ code: 0, data: { items } });
}

describe("FeishuUserDirectory", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves open_ids to names via the batch contact endpoint", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				usersResponse([{ open_id: "ou_alice", name: "Alice" }]),
			);
		vi.stubGlobal("fetch", fetchMock);

		const dir = new FeishuUserDirectory();
		const name = await dir.resolveName("t_1", "ou_alice");

		expect(name).toBe("Alice");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			"https://open.feishu.cn/open-apis/contact/v3/users/batch?user_id_type=open_id&user_ids=ou_alice",
		);
		expect(init.headers).toEqual({ Authorization: "Bearer t_1" });
	});

	it("resolves a batch and returns a map keyed by open_id", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				usersResponse([
					{ open_id: "ou_alice", name: "Alice" },
					{ open_id: "ou_bob", name: "Bob" },
				]),
			),
		);

		const dir = new FeishuUserDirectory();
		const names = await dir.resolveNames("t_1", ["ou_alice", "ou_bob"]);

		expect(names.get("ou_alice")).toBe("Alice");
		expect(names.get("ou_bob")).toBe("Bob");
	});

	it("caches resolved names — a second lookup makes no new request", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				usersResponse([{ open_id: "ou_alice", name: "Alice" }]),
			);
		vi.stubGlobal("fetch", fetchMock);

		const dir = new FeishuUserDirectory();
		expect(await dir.resolveName("t_1", "ou_alice")).toBe("Alice");
		expect(await dir.resolveName("t_1", "ou_alice")).toBe("Alice");

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("dedupes concurrent lookups of the same id into one request", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				usersResponse([{ open_id: "ou_alice", name: "Alice" }]),
			);
		vi.stubGlobal("fetch", fetchMock);

		const dir = new FeishuUserDirectory();
		const [a, b] = await Promise.all([
			dir.resolveName("t_1", "ou_alice"),
			dir.resolveName("t_1", "ou_alice"),
		]);

		expect(a).toBe("Alice");
		expect(b).toBe("Alice");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("returns undefined without throwing on an HTTP error (no permission)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false)));

		const dir = new FeishuUserDirectory();
		expect(await dir.resolveName("t_1", "ou_alice")).toBeUndefined();
	});

	it("returns undefined without throwing on a non-zero API code", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(jsonResponse({ code: 99991672, msg: "no scope" })),
		);

		const dir = new FeishuUserDirectory();
		expect(await dir.resolveName("t_1", "ou_alice")).toBeUndefined();
	});

	it("returns undefined without throwing on a network error", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

		const dir = new FeishuUserDirectory();
		expect(await dir.resolveName("t_1", "ou_alice")).toBeUndefined();
	});

	it("negative-caches a failed lookup so it isn't retried immediately", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false));
		vi.stubGlobal("fetch", fetchMock);

		const dir = new FeishuUserDirectory();
		expect(await dir.resolveName("t_1", "ou_alice")).toBeUndefined();
		expect(await dir.resolveName("t_1", "ou_alice")).toBeUndefined();

		// Second call was short-circuited by the negative cache.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("only requests uncached ids on a mixed batch", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				usersResponse([{ open_id: "ou_alice", name: "Alice" }]),
			)
			.mockResolvedValueOnce(
				usersResponse([{ open_id: "ou_bob", name: "Bob" }]),
			);
		vi.stubGlobal("fetch", fetchMock);

		const dir = new FeishuUserDirectory();
		await dir.resolveName("t_1", "ou_alice");
		const names = await dir.resolveNames("t_1", ["ou_alice", "ou_bob"]);

		expect(names.get("ou_alice")).toBe("Alice");
		expect(names.get("ou_bob")).toBe("Bob");
		// Alice came from cache; only Bob triggered a second request.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const secondUrl = fetchMock.mock.calls[1][0] as string;
		expect(secondUrl).toContain("user_ids=ou_bob");
		expect(secondUrl).not.toContain("ou_alice");
	});

	it("honours a custom (larksuite) base URL", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				usersResponse([{ open_id: "ou_alice", name: "Alice" }]),
			);
		vi.stubGlobal("fetch", fetchMock);

		const dir = new FeishuUserDirectory("https://open.larksuite.com/open-apis");
		await dir.resolveName("t_1", "ou_alice");

		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://open.larksuite.com/open-apis/contact/v3/users/batch?user_id_type=open_id&user_ids=ou_alice",
		);
	});

	it("ignores empty ids", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const dir = new FeishuUserDirectory();
		expect(await dir.resolveName("t_1", "")).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
