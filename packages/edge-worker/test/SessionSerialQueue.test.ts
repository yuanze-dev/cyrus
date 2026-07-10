import { describe, expect, it } from "vitest";
import { SessionSerialQueue } from "../src/SessionSerialQueue.js";

/** A promise plus its resolver, for driving deterministic ordering in tests. */
function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("SessionSerialQueue", () => {
	it("runs work for the same key strictly serially, in arrival order", async () => {
		const queue = new SessionSerialQueue();
		const order: string[] = [];
		const gate = deferred();

		// First unit blocks on a gate so the second cannot possibly start early.
		const first = queue.run("s1", async () => {
			order.push("first:start");
			await gate.promise;
			order.push("first:end");
		});
		const second = queue.run("s1", async () => {
			order.push("second:start");
			order.push("second:end");
		});

		// Give the microtask queue a chance to (incorrectly) run `second`.
		await Promise.resolve();
		expect(order).toEqual(["first:start"]);

		gate.resolve();
		await Promise.all([first, second]);

		expect(order).toEqual([
			"first:start",
			"first:end",
			"second:start",
			"second:end",
		]);
	});

	it("does not let a failed unit block later work for the same key", async () => {
		const queue = new SessionSerialQueue();
		const order: string[] = [];

		const failing = queue.run("s1", async () => {
			order.push("failing");
			throw new Error("boom");
		});
		const after = queue.run("s1", async () => {
			order.push("after");
		});

		// The caller still observes the rejection...
		await expect(failing).rejects.toThrow("boom");
		// ...but the chain keeps going.
		await after;
		expect(order).toEqual(["failing", "after"]);
	});

	it("runs different keys concurrently (independent chains)", async () => {
		const queue = new SessionSerialQueue();
		const order: string[] = [];
		const gate = deferred();

		const a = queue.run("a", async () => {
			order.push("a:start");
			await gate.promise;
			order.push("a:end");
		});
		const b = queue.run("b", async () => {
			// Runs even though key "a" is still blocked — different chain.
			order.push("b:done");
		});

		await b;
		expect(order).toEqual(["a:start", "b:done"]);

		gate.resolve();
		await a;
		expect(order).toEqual(["a:start", "b:done", "a:end"]);
	});

	it("tracks pending depth and clears back to idle", async () => {
		const queue = new SessionSerialQueue();
		const gate = deferred();

		const first = queue.run("s1", async () => {
			await gate.promise;
		});
		const second = queue.run("s1", async () => {});

		expect(queue.depth("s1")).toBe(2);
		expect(queue.isBusy).toBe(true);
		expect(queue.depth("other")).toBe(0);

		gate.resolve();
		await Promise.all([first, second]);

		expect(queue.depth("s1")).toBe(0);
		expect(queue.isBusy).toBe(false);
	});

	it("returns each unit's own resolved value to its caller", async () => {
		const queue = new SessionSerialQueue();
		const a = queue.run("s1", async () => 1);
		const b = queue.run("s1", async () => 2);
		expect(await a).toBe(1);
		expect(await b).toBe(2);
	});
});
