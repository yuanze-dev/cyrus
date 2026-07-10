import type { AgentActivityContent } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FeishuBackflowBinding,
	type FeishuBackflowNotifier,
	FeishuBackflowSink,
} from "../src/FeishuBackflowSink.js";

const BINDING: FeishuBackflowBinding = {
	chatId: "oc_chat",
	rootMessageId: "om_root",
};

const SESSION = "session-1";

/** Cast a plain activity literal to the SDK union without pulling in its shape. */
function activity(content: Record<string, unknown>): AgentActivityContent {
	return content as unknown as AgentActivityContent;
}

function makeSink(
	notifier: FeishuBackflowNotifier,
	opts?: {
		enabled?: boolean;
		binding?: FeishuBackflowBinding | undefined;
		throttleWindowMs?: number;
	},
) {
	let clock = 1_000;
	const enabled = opts?.enabled ?? true;
	const sink = new FeishuBackflowSink({
		notifier,
		resolveBinding: () => (opts && "binding" in opts ? opts.binding : BINDING),
		isEnabled: () => enabled,
		now: () => clock,
		throttleWindowMs: opts?.throttleWindowMs ?? 5_000,
	});
	return {
		sink,
		advanceClock: (ms: number) => {
			clock += ms;
		},
	};
}

describe("FeishuBackflowSink", () => {
	let notifier: ReturnType<typeof vi.fn> & FeishuBackflowNotifier;

	beforeEach(() => {
		notifier = vi.fn().mockResolvedValue(undefined) as never;
	});

	it("backflows a turn-final response to the Feishu thread", async () => {
		const { sink } = makeSink(notifier);
		await sink.onActivity(
			SESSION,
			activity({ type: "response", body: "All done — PR opened." }),
		);

		expect(notifier).toHaveBeenCalledTimes(1);
		const call = notifier.mock.calls[0][0];
		expect(call.rootMessageId).toBe("om_root");
		expect(call.chatId).toBe("oc_chat");
		expect(call.text).toBe("All done — PR opened.");
	});

	it("does NOT backflow non-milestone activities (thought/action/elicitation)", async () => {
		const { sink } = makeSink(notifier);
		await sink.onActivity(SESSION, activity({ type: "thought", body: "hmm" }));
		await sink.onActivity(
			SESSION,
			activity({ type: "action", action: "Bash", parameter: "ls" }),
		);
		await sink.onActivity(
			SESSION,
			activity({ type: "elicitation", body: "need input" }),
		);

		expect(notifier).not.toHaveBeenCalled();
	});

	it("does NOT backflow ephemeral activities even if typed as response", async () => {
		const { sink } = makeSink(notifier);
		await sink.onActivity(
			SESSION,
			activity({ type: "response", body: "streaming…" }),
			{ ephemeral: true },
		);
		expect(notifier).not.toHaveBeenCalled();
	});

	it("only surfaces milestones amid a flood of process noise (no spam)", async () => {
		const { sink } = makeSink(notifier);
		// Simulate a busy turn: many thoughts/actions, then a single response.
		for (let i = 0; i < 20; i++) {
			await sink.onActivity(
				SESSION,
				activity({ type: "thought", body: `thinking ${i}` }),
			);
			await sink.onActivity(
				SESSION,
				activity({ type: "action", action: "Bash", parameter: `cmd ${i}` }),
			);
		}
		await sink.onActivity(
			SESSION,
			activity({ type: "response", body: "Final answer." }),
		);

		expect(notifier).toHaveBeenCalledTimes(1);
		expect(notifier.mock.calls[0][0].text).toBe("Final answer.");
	});

	it("backflows error activities as milestones", async () => {
		const { sink } = makeSink(notifier);
		await sink.onActivity(
			SESSION,
			activity({ type: "error", body: "Rate limited." }),
		);
		expect(notifier).toHaveBeenCalledTimes(1);
		expect(notifier.mock.calls[0][0].text).toBe("Rate limited.");
	});

	it("is idempotent: the same response is not re-posted for a session", async () => {
		const { sink } = makeSink(notifier);
		const resp = activity({ type: "response", body: "Same answer." });
		await sink.onActivity(SESSION, resp);
		await sink.onActivity(SESSION, resp);
		await sink.onActivity(SESSION, resp);
		expect(notifier).toHaveBeenCalledTimes(1);
	});

	it("throttles identical text posted moments apart, but allows it after the window", async () => {
		const { sink, advanceClock } = makeSink(notifier, {
			throttleWindowMs: 5_000,
		});
		// Two different sessions posting identical text — dedup key differs per
		// session, so throttle (per-session, time-based) is what we exercise here by
		// re-posting distinct content then the same content within the window.
		await sink.onActivity(
			SESSION,
			activity({ type: "response", body: "answer A" }),
		);
		// A different milestone (distinct dedup key) with identical text is throttled.
		await sink.onActivity(
			SESSION,
			activity({ type: "error", body: "answer A" }),
		);
		expect(notifier).toHaveBeenCalledTimes(1);

		// After the window, the throttle no longer blocks it.
		advanceClock(6_000);
		await sink.onActivity(
			SESSION,
			activity({ type: "error", body: "answer A" }),
		);
		expect(notifier).toHaveBeenCalledTimes(2);
	});

	it("posts distinct milestones across turns for the same session", async () => {
		const { sink, advanceClock } = makeSink(notifier);
		await sink.onActivity(
			SESSION,
			activity({ type: "response", body: "turn 1 answer" }),
		);
		advanceClock(10_000);
		await sink.onActivity(
			SESSION,
			activity({ type: "response", body: "turn 2 answer" }),
		);
		expect(notifier).toHaveBeenCalledTimes(2);
		expect(notifier.mock.calls[1][0].text).toBe("turn 2 answer");
	});

	it("is a complete no-op when the flag is disabled", async () => {
		const { sink } = makeSink(notifier, { enabled: false });
		await sink.onActivity(
			SESSION,
			activity({ type: "response", body: "Final answer." }),
		);
		expect(notifier).not.toHaveBeenCalled();
	});

	it("no-ops when the session has no Feishu binding", async () => {
		const { sink } = makeSink(notifier, { binding: undefined });
		await sink.onActivity(
			SESSION,
			activity({ type: "response", body: "Final answer." }),
		);
		expect(notifier).not.toHaveBeenCalled();
	});

	it("skips empty/whitespace bodies", async () => {
		const { sink } = makeSink(notifier);
		await sink.onActivity(SESSION, activity({ type: "response", body: "   " }));
		await sink.onActivity(SESSION, activity({ type: "response", body: "" }));
		expect(notifier).not.toHaveBeenCalled();
	});

	it("truncates very long bodies", async () => {
		const { sink } = makeSink(notifier);
		const long = "x".repeat(5_000);
		await sink.onActivity(SESSION, activity({ type: "response", body: long }));
		const text = notifier.mock.calls[0][0].text as string;
		expect(text.length).toBeLessThan(long.length);
		expect(text.endsWith("…")).toBe(true);
	});

	it("does not mark a milestone as posted when delivery fails (allows retry)", async () => {
		const failing = vi
			.fn()
			.mockRejectedValueOnce(new Error("feishu down"))
			.mockResolvedValueOnce(undefined) as never as FeishuBackflowNotifier;
		const { sink } = makeSink(failing);
		const resp = activity({ type: "response", body: "retry me" });

		// First attempt fails but is swallowed (onActivity never throws).
		await sink.onActivity(SESSION, resp);
		// Second attempt succeeds because the key was not stamped.
		await sink.onActivity(SESSION, resp);

		expect(failing).toHaveBeenCalledTimes(2);
	});

	describe("postStateChange", () => {
		it("posts a terminal-state milestone once per (session, state)", async () => {
			const { sink } = makeSink(notifier);
			await sink.postStateChange(SESSION, BINDING, {
				stateType: "canceled",
				text: "Task canceled.",
			});
			await sink.postStateChange(SESSION, BINDING, {
				stateType: "canceled",
				text: "Task canceled.",
			});
			expect(notifier).toHaveBeenCalledTimes(1);
			expect(notifier.mock.calls[0][0].text).toBe("Task canceled.");
		});

		it("is a no-op when the flag is disabled", async () => {
			const { sink } = makeSink(notifier, { enabled: false });
			await sink.postStateChange(SESSION, BINDING, {
				stateType: "canceled",
				text: "Task canceled.",
			});
			expect(notifier).not.toHaveBeenCalled();
		});
	});
});
