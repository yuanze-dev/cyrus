import { describe, expect, it } from "vitest";
import { ChannelLoopGuard } from "../src/ChannelLoopGuard.js";

const CH = "oc_chat:om_root";

describe("ChannelLoopGuard", () => {
	it("processes a first-seen inbound message", () => {
		const guard = new ChannelLoopGuard();
		expect(guard.shouldProcessInbound(CH, "hello")).toBe(true);
	});

	it("drops a duplicate inbound within the TTL", () => {
		const guard = new ChannelLoopGuard();
		expect(guard.shouldProcessInbound(CH, "hello")).toBe(true);
		expect(guard.shouldProcessInbound(CH, "hello")).toBe(false);
	});

	it("drops an inbound that echoes an outbound notice (origin marking)", () => {
		const guard = new ChannelLoopGuard();
		// The runtime posts a completion notice into the thread…
		guard.markOutbound(CH, "✅ Done: created issue ENG-1");
		// …which is then (hypothetically) re-ingested as an inbound event.
		expect(guard.shouldProcessInbound(CH, "✅ Done: created issue ENG-1")).toBe(
			false,
		);
	});

	it("treats the same content in a different channel as fresh", () => {
		const guard = new ChannelLoopGuard();
		guard.markOutbound(CH, "notice");
		expect(guard.shouldProcessInbound("oc_other:om_x", "notice")).toBe(true);
	});

	it("treats different content in the same channel as fresh", () => {
		const guard = new ChannelLoopGuard();
		expect(guard.shouldProcessInbound(CH, "first")).toBe(true);
		expect(guard.shouldProcessInbound(CH, "second")).toBe(true);
	});

	it("ignores surrounding whitespace when hashing content", () => {
		const guard = new ChannelLoopGuard();
		guard.markOutbound(CH, "notice");
		expect(guard.shouldProcessInbound(CH, "  notice  ")).toBe(false);
	});

	it("never deduplicates empty content", () => {
		const guard = new ChannelLoopGuard();
		expect(guard.shouldProcessInbound(CH, "")).toBe(true);
		expect(guard.shouldProcessInbound(CH, "   ")).toBe(true);
		expect(guard.size()).toBe(0);
	});

	it("never deduplicates when the channel key is empty", () => {
		const guard = new ChannelLoopGuard();
		expect(guard.shouldProcessInbound("", "hello")).toBe(true);
		expect(guard.shouldProcessInbound("", "hello")).toBe(true);
	});

	it("allows the same content again once the TTL elapses", () => {
		let now = 1_000;
		const guard = new ChannelLoopGuard(1_000, () => now);
		expect(guard.shouldProcessInbound(CH, "yes")).toBe(true);
		now = 1_500;
		expect(guard.shouldProcessInbound(CH, "yes")).toBe(false); // still within window
		now = 2_500;
		expect(guard.shouldProcessInbound(CH, "yes")).toBe(true); // window elapsed
	});

	it("prunes expired entries so size() stays bounded", () => {
		let now = 0;
		const guard = new ChannelLoopGuard(100, () => now);
		guard.shouldProcessInbound(CH, "a");
		guard.markOutbound(CH, "b");
		expect(guard.size()).toBe(2);
		now = 1_000;
		expect(guard.size()).toBe(0);
	});
});
