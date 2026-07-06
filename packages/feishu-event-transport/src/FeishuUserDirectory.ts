/**
 * Resolves Feishu (Lark) `open_id`s into human display names via the Contact
 * API, with a process-wide cache.
 *
 * A Feishu message only carries the sender's opaque `open_id` (e.g.
 * `ou_ea1fe5f5d6915e3495b3673726322581`), never a name. To let the agent talk
 * about "who asked", we translate those ids using
 * `GET /contact/v3/users/batch?user_ids=...&user_id_type=open_id` and cache the
 * result so the same id is never fetched twice within a process.
 *
 * Everything here is strictly best-effort: any failure (missing scope, non-2xx,
 * `code !== 0`, network error) resolves to "no name" rather than throwing, so a
 * lack of the `contact:user.base:readonly` permission degrades gracefully to the
 * bare open_id instead of breaking the session.
 *
 * This object is meant to be long-lived (created once and reused) so its cache
 * actually persists — do NOT `new` it per event.
 *
 * @see https://open.feishu.cn/document/server-docs/contact-v3/user/batch
 */

import { FEISHU_DEFAULT_BASE_URL } from "./FeishuTokenProvider.js";

/** Raw user item shape returned by the Contact batch endpoint. */
interface FeishuRawUser {
	open_id?: string;
	name?: string;
}

export class FeishuUserDirectory {
	private readonly apiBaseUrl: string;

	/** open_id → resolved display name (positive cache). */
	private readonly cache = new Map<string, string>();
	/** open_id → epoch ms until which we should not retry a failed lookup. */
	private readonly negativeCache = new Map<string, number>();
	/** In-flight lookups, keyed by open_id, so concurrent callers dedupe. */
	private readonly inflight = new Map<string, Promise<string | undefined>>();

	/** Don't re-request an open_id that failed to resolve for this long. */
	private static readonly NEGATIVE_TTL_MS = 5 * 60 * 1000;
	/** Feishu caps the batch endpoint at 50 ids per request. */
	private static readonly BATCH_SIZE = 50;

	constructor(apiBaseUrl?: string) {
		this.apiBaseUrl = (apiBaseUrl ?? FEISHU_DEFAULT_BASE_URL).replace(
			/\/+$/,
			"",
		);
	}

	/**
	 * Resolve a single open_id to a display name, or undefined when it can't be
	 * resolved. Never throws.
	 */
	async resolveName(
		token: string,
		openId: string,
	): Promise<string | undefined> {
		if (!openId) {
			return undefined;
		}
		const names = await this.resolveNames(token, [openId]);
		return names.get(openId);
	}

	/**
	 * Resolve a batch of open_ids to display names. The returned map only contains
	 * entries that resolved successfully; unresolved ids are simply absent. Never
	 * throws — all failures are swallowed and fall back to "no name".
	 */
	async resolveNames(
		token: string,
		openIds: string[],
	): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		const waits: Promise<void>[] = [];
		const toFetch: string[] = [];

		for (const id of new Set(openIds)) {
			if (!id) {
				continue;
			}
			const cached = this.cache.get(id);
			if (cached !== undefined) {
				result.set(id, cached);
				continue;
			}
			if (this.isNegativelyCached(id)) {
				continue;
			}
			const existing = this.inflight.get(id);
			if (existing) {
				// Another caller is already fetching this id — piggyback on it.
				waits.push(
					existing.then((name) => {
						if (name) {
							result.set(id, name);
						}
					}),
				);
				continue;
			}
			toFetch.push(id);
		}

		// Fetch anything not cached / not already in flight, in batches.
		for (let i = 0; i < toFetch.length; i += FeishuUserDirectory.BATCH_SIZE) {
			const batch = toFetch.slice(i, i + FeishuUserDirectory.BATCH_SIZE);
			const batchPromise = this.fetchBatch(token, batch);
			for (const id of batch) {
				const perId = batchPromise
					.then((names) => names.get(id))
					.finally(() => {
						this.inflight.delete(id);
					});
				this.inflight.set(id, perId);
				waits.push(
					perId.then((name) => {
						if (name) {
							result.set(id, name);
						}
					}),
				);
			}
		}

		await Promise.all(waits);
		return result;
	}

	/** Whether an id is within its no-retry window after a failed lookup. */
	private isNegativelyCached(openId: string): boolean {
		const until = this.negativeCache.get(openId);
		if (until === undefined) {
			return false;
		}
		if (Date.now() >= until) {
			this.negativeCache.delete(openId);
			return false;
		}
		return true;
	}

	/** Short-term negative-cache an id so a failed lookup isn't hammered. */
	private markFailed(openIds: string[]): void {
		const until = Date.now() + FeishuUserDirectory.NEGATIVE_TTL_MS;
		for (const id of openIds) {
			this.negativeCache.set(id, until);
		}
	}

	/**
	 * Fetch a single batch of open_ids from the Contact API. Populates the
	 * positive cache for resolved ids and negative-caches the rest. Returns a map
	 * of the ids that resolved. Never throws.
	 */
	private async fetchBatch(
		token: string,
		openIds: string[],
	): Promise<Map<string, string>> {
		const resolved = new Map<string, string>();
		try {
			const query = new URLSearchParams({ user_id_type: "open_id" });
			for (const id of openIds) {
				query.append("user_ids", id);
			}
			const url = `${this.apiBaseUrl}/contact/v3/users/batch?${query.toString()}`;
			const response = await fetch(url, {
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) {
				this.markFailed(openIds);
				return resolved;
			}
			const body = (await response.json()) as {
				code: number;
				data?: { items?: FeishuRawUser[] };
			};
			if (body.code !== 0) {
				this.markFailed(openIds);
				return resolved;
			}
			for (const item of body.data?.items ?? []) {
				if (item.open_id && item.name) {
					this.cache.set(item.open_id, item.name);
					resolved.set(item.open_id, item.name);
				}
			}
			// Any id the API didn't return a name for gets negative-cached so we
			// don't retry it on every message.
			const missing = openIds.filter((id) => !resolved.has(id));
			if (missing.length > 0) {
				this.markFailed(missing);
			}
			return resolved;
		} catch {
			this.markFailed(openIds);
			return resolved;
		}
	}
}
