import { describe, expect, it } from "vitest";
import { EventDeduplicator } from "../src/EventDeduplicator.js";

describe("EventDeduplicator", () => {
	it("marks a fresh event_id as seen and returns true the first time", () => {
		const dedup = new EventDeduplicator();
		expect(dedup.markSeen("evt_1")).toBe(true);
	});

	it("returns false on a repeated event_id", () => {
		const dedup = new EventDeduplicator();
		expect(dedup.markSeen("evt_1")).toBe(true);
		expect(dedup.markSeen("evt_1")).toBe(false);
		expect(dedup.markSeen("evt_1")).toBe(false);
	});

	it("treats distinct ids independently", () => {
		const dedup = new EventDeduplicator();
		expect(dedup.markSeen("evt_1")).toBe(true);
		expect(dedup.markSeen("evt_2")).toBe(true);
		expect(dedup.markSeen("evt_1")).toBe(false);
		expect(dedup.markSeen("evt_2")).toBe(false);
	});

	it("never deduplicates empty ids (each is treated as fresh)", () => {
		const dedup = new EventDeduplicator();
		expect(dedup.markSeen("")).toBe(true);
		expect(dedup.markSeen("")).toBe(true);
		expect(dedup.size()).toBe(0);
	});

	it("forgets ids once the TTL elapses", () => {
		let now = 1_000;
		const dedup = new EventDeduplicator(1_000, () => now);
		expect(dedup.markSeen("evt_1")).toBe(true);
		// Within the window → still a duplicate.
		now = 1_500;
		expect(dedup.markSeen("evt_1")).toBe(false);
		// Past the window → pruned, so it is fresh again.
		now = 2_500;
		expect(dedup.markSeen("evt_1")).toBe(true);
	});

	it("prunes expired ids so size() stays bounded", () => {
		let now = 0;
		const dedup = new EventDeduplicator(100, () => now);
		dedup.markSeen("a");
		dedup.markSeen("b");
		expect(dedup.size()).toBe(2);
		now = 1_000;
		expect(dedup.size()).toBe(0);
	});
});
