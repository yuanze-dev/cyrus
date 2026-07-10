/**
 * EventDeduplicator — a small, shareable TTL set of recently-seen `event_id`s.
 *
 * Feishu delivers the same logical event over more than one channel: the HTTP
 * webhook ({@link FeishuEventTransport}) AND the long-connection WebSocket
 * ({@link FeishuWsClient}) can both be active, and each retries independently on
 * failure. Historically each transport kept its OWN in-memory `event_id` map, so
 * an event that arrived once over the webhook and once over the WS slipped past
 * both filters and got injected twice (IN-42 §5 P5 / IN-50).
 *
 * Sharing a single {@link EventDeduplicator} instance across both transports
 * collapses those two per-transport windows into one: whichever transport sees an
 * `event_id` first claims it, and the other drops its copy.
 *
 * Semantics are deliberately identical to the two maps it replaces — a bounded
 * `Map<event_id, seenAt>` pruned lazily on each check against a TTL — so behavior
 * for a single transport is unchanged; only the sharing is new.
 */
export class EventDeduplicator {
	/** Recently seen `event_id`s → epoch-ms they were first seen. */
	private readonly recentEventIds: Map<string, number> = new Map();
	private readonly ttlMs: number;
	private readonly now: () => number;

	/**
	 * @param ttlMs How long an `event_id` is remembered. Defaults to 10 minutes,
	 *   matching the previous per-transport windows.
	 * @param now Injectable clock (epoch ms) for deterministic tests.
	 */
	constructor(ttlMs: number = 10 * 60 * 1000, now: () => number = Date.now) {
		this.ttlMs = ttlMs;
		this.now = now;
	}

	/**
	 * Atomically test-and-record an `event_id`.
	 *
	 * @returns `true` when the id was seen for the FIRST time (the caller should
	 *   process the event); `false` when it is a duplicate (drop it). An empty id
	 *   is never deduplicated — it is always treated as fresh — since some
	 *   deliveries carry no usable id and must not all collapse onto `""`.
	 */
	markSeen(eventId: string): boolean {
		if (!eventId) {
			return true;
		}
		this.prune();
		if (this.recentEventIds.has(eventId)) {
			return false;
		}
		this.recentEventIds.set(eventId, this.now());
		return true;
	}

	/** Number of ids currently remembered (post-prune). Exposed for tests/diagnostics. */
	size(): number {
		this.prune();
		return this.recentEventIds.size;
	}

	/** Drop ids older than the TTL so memory stays bounded on long-lived processes. */
	private prune(): void {
		const cutoff = this.now() - this.ttlMs;
		for (const [key, seenAt] of this.recentEventIds) {
			if (seenAt <= cutoff) {
				this.recentEventIds.delete(key);
			}
		}
	}
}
