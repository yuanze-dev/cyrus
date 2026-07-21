/**
 * Unit tests for SessionCorrelationRegistry (GlobalSessionRegistry alias)
 *
 * The registry now holds only the two correlation maps — child→parent and
 * channelKey→sessionId. The session/entry storage half was removed as dead code
 * in IN-42 §5 P6 (the single source of truth for sessions is AgentSessionManager).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	GlobalSessionRegistry,
	SessionCorrelationRegistry,
} from "../src/GlobalSessionRegistry.js";

describe("SessionCorrelationRegistry naming", () => {
	it("exposes SessionCorrelationRegistry with GlobalSessionRegistry as a backward-compatible alias", () => {
		expect(SessionCorrelationRegistry).toBe(GlobalSessionRegistry);
		expect(new SessionCorrelationRegistry()).toBeInstanceOf(
			GlobalSessionRegistry,
		);
	});
});

describe("SessionCorrelationRegistry", () => {
	let registry: SessionCorrelationRegistry;

	beforeEach(() => {
		registry = new SessionCorrelationRegistry();
	});

	describe("Parent-Child Mapping", () => {
		it("should set and get parent session ID", () => {
			registry.setParentSession("child-1", "parent-1");
			expect(registry.getParentSessionId("child-1")).toBe("parent-1");
		});

		it("should return undefined for child with no parent", () => {
			expect(registry.getParentSessionId("child-1")).toBeUndefined();
		});

		it("should handle multiple parent-child relationships", () => {
			registry.setParentSession("child-1", "parent-1");
			registry.setParentSession("child-2", "parent-2");

			expect(registry.getParentSessionId("child-1")).toBe("parent-1");
			expect(registry.getParentSessionId("child-2")).toBe("parent-2");
		});

		it("should overwrite an existing parent mapping (last-write-wins)", () => {
			registry.setParentSession("child-1", "parent-1");
			registry.setParentSession("child-1", "parent-2");
			expect(registry.getParentSessionId("child-1")).toBe("parent-2");
		});
	});

	describe("Channel Correlation (IN-42 §5 P0)", () => {
		it("should resolve a bound channel key to its session id (hit)", () => {
			registry.bind("oc_chat:omt_thread", "session-1");
			expect(registry.resolve("oc_chat:omt_thread")).toBe("session-1");
		});

		it("should return undefined for an unbound channel key (miss)", () => {
			registry.bind("oc_chat:omt_thread", "session-1");
			expect(registry.resolve("oc_chat:other")).toBeUndefined();
			expect(registry.resolve("never-bound")).toBeUndefined();
		});

		it("should overwrite an existing binding (last-write-wins)", () => {
			registry.bind("oc_chat:omt_thread", "session-1");
			registry.bind("oc_chat:omt_thread", "session-2");
			expect(registry.resolve("oc_chat:omt_thread")).toBe("session-2");
		});

		it("should map multiple alias keys to the same session id", () => {
			// A Feishu topic whose key shifts messageId -> threadId: both the
			// canonical key and its aliases resolve to one logical session.
			registry.bind("oc_chat:om_msg1", "session-1");
			registry.bind("oc_chat:omt_thread", "session-1");
			expect(registry.resolve("oc_chat:om_msg1")).toBe("session-1");
			expect(registry.resolve("oc_chat:omt_thread")).toBe("session-1");
		});
	});

	describe("Serialization", () => {
		it("should serialize the correlation maps", () => {
			registry.setParentSession("session-1", "parent-1");
			registry.bind("oc_chat:omt_thread", "session-1");

			const serialized = registry.serializeState();

			expect(serialized.childToParentMap["session-1"]).toBe("parent-1");
			expect(serialized.sessionChannelIndex["oc_chat:omt_thread"]).toBe(
				"session-1",
			);
		});

		it("should serialize empty maps as empty objects", () => {
			const serialized = registry.serializeState();
			expect(serialized.childToParentMap).toEqual({});
			expect(serialized.sessionChannelIndex).toEqual({});
		});

		it("should round-trip through the EdgeWorker restore path (bind + setParentSession)", () => {
			// EdgeWorker.restoreMappings rebuilds a fresh registry directly from the
			// serialized maps — it does not call a restoreState method. Mirror that.
			registry.setParentSession("child-1", "parent-1");
			registry.bind("oc_chat:om_msg1", "session-1");
			registry.bind("oc_chat:omt_thread", "session-1");

			const serialized = registry.serializeState();
			const restored = new SessionCorrelationRegistry();
			for (const [childId, parentId] of Object.entries(
				serialized.childToParentMap,
			)) {
				restored.setParentSession(childId, parentId);
			}
			for (const [channelKey, sessionId] of Object.entries(
				serialized.sessionChannelIndex,
			)) {
				restored.bind(channelKey, sessionId);
			}

			expect(restored.getParentSessionId("child-1")).toBe("parent-1");
			expect(restored.resolve("oc_chat:om_msg1")).toBe("session-1");
			expect(restored.resolve("oc_chat:omt_thread")).toBe("session-1");
		});
	});
});
