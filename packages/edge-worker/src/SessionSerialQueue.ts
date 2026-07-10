/**
 * SessionSerialQueue — per-key serialization of async work (IN-42 §5 P3).
 *
 * Generalizes the promise-chaining pattern already used inside
 * {@link AgentSessionManager} for `handleClaudeMessage` (its private
 * `messageProcessingQueues`) into a small, reusable primitive so that ALL
 * incoming prompts for a single logical session — regardless of which channel
 * (Feishu thread, Linear agent session, Slack) they arrive on — are processed
 * one at a time, in arrival order.
 *
 * Why this matters: EdgeWorker dispatches messages fire-and-forget, so without
 * serialization two channels prompting the same session concurrently could each
 * observe "runner idle" and both start a turn (a concurrent-turn race), or
 * inject out of order. Chaining every unit of work for a `sessionId` onto that
 * session's tail promise removes the race by construction: work N+1 for a key
 * never begins until work N settles.
 *
 * Independent keys never block each other — each `sessionId` has its own chain.
 * A failing unit of work is isolated: its rejection is surfaced to that caller
 * but the chain continues, so one bad prompt cannot wedge a session's queue.
 */
export class SessionSerialQueue {
	/** Per-key tail promise. Awaiting it means "all previously queued work done". */
	private readonly tails: Map<string, Promise<unknown>> = new Map();
	/**
	 * Per-key count of not-yet-settled work units (queued + running). Used only
	 * for observability/tests — the ordering guarantee comes from the promise
	 * chain, not this counter.
	 */
	private readonly pending: Map<string, number> = new Map();

	/**
	 * Enqueue `work` for `key`. It runs after every unit previously enqueued for
	 * the same key has settled. Returns a promise that resolves/rejects with
	 * `work`'s own result, so callers still see their errors, while the internal
	 * chain swallows them so a failure never blocks later work for the key.
	 */
	run<T>(key: string, work: () => Promise<T>): Promise<T> {
		const prev = this.tails.get(key) ?? Promise.resolve();
		this.pending.set(key, (this.pending.get(key) ?? 0) + 1);

		const result = prev.then(() => work());

		// The chain tail must never reject (that would poison every subsequent
		// unit for this key). Swallow here; the caller still gets `result`.
		const tail = result
			.catch(() => undefined)
			.finally(() => {
				const remaining = (this.pending.get(key) ?? 1) - 1;
				if (remaining <= 0) {
					this.pending.delete(key);
					// Only drop the tail if no newer work replaced it in the meantime.
					if (this.tails.get(key) === tail) {
						this.tails.delete(key);
					}
				} else {
					this.pending.set(key, remaining);
				}
			});

		this.tails.set(key, tail);
		return result;
	}

	/**
	 * Number of work units queued or running for `key` (0 when the key is idle).
	 * For diagnostics and tests only.
	 */
	depth(key: string): number {
		return this.pending.get(key) ?? 0;
	}

	/** True when any key currently has outstanding work. */
	get isBusy(): boolean {
		return this.pending.size > 0;
	}
}
