import type { AgentActivityContent, ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";
import type { ActivityPostOptions } from "./sinks/index.js";

/**
 * Everything needed to reply back into a Feishu (Lark) thread. Resolved from a
 * session's `feishu` {@link ChannelBinding} (or the legacy
 * {@link SerializedFeishuIssueBinding}); the sink itself stays free of session
 * internals so it is trivially unit-testable.
 */
export interface FeishuBackflowBinding {
	/** Feishu chat id (e.g. "oc_..."), for logging/diagnostics. */
	chatId: string;
	/** Thread-root message id to reply to (kept in-thread via reply_in_thread). */
	rootMessageId: string;
}

/**
 * Delivers a composed notice into a Feishu thread. Shared with
 * {@link FeishuIssueNotificationService.FeishuThreadNotifier} — the EdgeWorker
 * implementation (`postFeishuThreadNotice`) replies with the bot identity, which
 * is what keeps a backflow message from being re-ingested (the Feishu
 * translator's self-author filter drops the bot's own messages). Should throw on
 * failure so the caller can leave the node un-stamped for a later retry.
 */
export type FeishuBackflowNotifier = (params: {
	rootMessageId: string;
	chatId: string;
	text: string;
}) => Promise<void>;

export interface FeishuBackflowSinkDeps {
	/** Delivers the composed notice into the Feishu thread (bot identity). */
	notifier: FeishuBackflowNotifier;
	/**
	 * Resolve the Feishu thread a logical session should backflow to, or
	 * `undefined` when the session is not reachable from Feishu (no binding). Kept
	 * as a callback so the sink never reaches into {@link AgentSessionManager}.
	 */
	resolveBinding: (sessionId: string) => FeishuBackflowBinding | undefined;
	/**
	 * Live feature-flag read. When it returns false the sink is a complete no-op,
	 * so flipping the flag off instantly reverts to the legacy "completion-only"
	 * notice with no re-registration.
	 */
	isEnabled: () => boolean;
	logger?: ILogger;
	/** Injectable clock (epoch ms) for deterministic tests. Defaults to Date.now. */
	now?: () => number;
	/**
	 * Throttle window: two milestones with identical text posted to the same
	 * session within this window collapse into one. Guards against a burst of
	 * duplicate responses. Defaults to 5s.
	 */
	throttleWindowMs?: number;
	/** Max characters of a milestone body posted to a thread. Longer bodies are truncated. */
	maxBodyChars?: number;
}

/** Kind of milestone being backflowed — used to build a stable idempotency key. */
type MilestoneKind = "response" | "error" | "state";

const DEFAULT_THROTTLE_WINDOW_MS = 5_000;
const DEFAULT_MAX_BODY_CHARS = 1_500;
/** Cap on remembered idempotency keys per session, so memory stays bounded. */
const MAX_KEYS_PER_SESSION = 64;

/**
 * Reflects a logical session's **milestones** (turn-final response, failures,
 * terminal state changes) back into the Feishu thread that originated it —
 * generalizing the old "completion-only" notice into a live process feed
 * (IN-42 §Q4 / §5 P4).
 *
 * It plugs into {@link AgentSessionManager} as an activity observer: every
 * activity posted to Linear is offered here, and only milestones are forwarded.
 * Three guards keep the thread readable and loop-safe:
 *
 * 1. **Milestone filter** — `thought` / `action` / `elicitation` / ephemeral
 *    activities are dropped, so the thread gets the answer, not every keystroke.
 * 2. **Idempotency** — each milestone maps to a stable key (`state:completed`,
 *    `response:<hash>`, …); a key is posted at most once per session, so a
 *    repeated webhook or re-render never double-posts.
 * 3. **Throttle** — identical text posted to the same session inside
 *    {@link FeishuBackflowSinkDeps.throttleWindowMs} collapses to one post.
 *
 * Re-ingestion is prevented upstream: {@link FeishuBackflowSinkDeps.notifier}
 * posts as the bot, and the Feishu translator's self-author filter discards the
 * bot's own messages.
 */
export class FeishuBackflowSink {
	private readonly notifier: FeishuBackflowNotifier;
	private readonly resolveBinding: (
		sessionId: string,
	) => FeishuBackflowBinding | undefined;
	private readonly isEnabled: () => boolean;
	private readonly now: () => number;
	private readonly throttleWindowMs: number;
	private readonly maxBodyChars: number;
	private readonly logger: ILogger;

	/** Idempotency: milestone keys already posted, per session (insertion-ordered). */
	private readonly postedKeys = new Map<string, Set<string>>();
	/** Throttle: last posted text hash + timestamp, per session. */
	private readonly lastPost = new Map<string, { hash: string; at: number }>();

	constructor(deps: FeishuBackflowSinkDeps) {
		this.notifier = deps.notifier;
		this.resolveBinding = deps.resolveBinding;
		this.isEnabled = deps.isEnabled;
		this.now = deps.now ?? (() => Date.now());
		this.throttleWindowMs = deps.throttleWindowMs ?? DEFAULT_THROTTLE_WINDOW_MS;
		this.maxBodyChars = deps.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
		this.logger =
			deps.logger ?? createLogger({ component: "FeishuBackflowSink" });
	}

	/**
	 * Activity-observer entry point. Called for every activity posted to the
	 * primary (Linear) sink; only milestones are forwarded to Feishu. Never
	 * throws — a backflow failure must not disturb the primary Linear timeline.
	 */
	async onActivity(
		sessionId: string,
		content: AgentActivityContent,
		options?: ActivityPostOptions,
	): Promise<void> {
		try {
			if (!this.isEnabled()) {
				return;
			}
			// Ephemeral activities (in-flight tool calls) are replaced by the next
			// render — never a milestone.
			if (options?.ephemeral) {
				return;
			}
			const milestone = this.classifyMilestone(content);
			if (!milestone) {
				return;
			}
			const binding = this.resolveBinding(sessionId);
			if (!binding) {
				return;
			}
			const text = this.truncate(milestone.body);
			if (!text) {
				return;
			}
			await this.deliver(sessionId, binding, milestone.key, text);
		} catch (error) {
			this.logger.warn(
				`Feishu backflow (activity) failed for session ${sessionId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	/**
	 * Explicit milestone entry point for terminal state changes
	 * (completed / canceled / failed) that do not flow through the activity path.
	 * Idempotent per (session, state). Never throws.
	 */
	async postStateChange(
		sessionId: string,
		binding: FeishuBackflowBinding,
		params: { stateType: string; text: string },
	): Promise<void> {
		try {
			if (!this.isEnabled()) {
				return;
			}
			const text = this.truncate(params.text);
			if (!text) {
				return;
			}
			await this.deliver(sessionId, binding, `state:${params.stateType}`, text);
		} catch (error) {
			this.logger.warn(
				`Feishu backflow (state ${params.stateType}) failed for session ${sessionId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	/**
	 * Forget a session's dedup/throttle state. Called when a session is removed so
	 * a brand-new session reusing the same id (unlikely) starts clean and memory
	 * does not grow unbounded across long-lived processes.
	 */
	forgetSession(sessionId: string): void {
		this.postedKeys.delete(sessionId);
		this.lastPost.delete(sessionId);
	}

	/**
	 * Decide whether an activity is a backflow-worthy milestone. Only the
	 * turn-final `response` and `error` activities qualify; `thought`, `action`,
	 * `elicitation`, and `prompt` are process noise that would flood the thread.
	 */
	private classifyMilestone(
		content: AgentActivityContent,
	): { key: string; body: string } | null {
		const type = (content as { type?: string }).type;
		const body = (content as { body?: unknown }).body;
		if (typeof body !== "string" || body.trim() === "") {
			return null;
		}
		const kind: MilestoneKind | null =
			type === "response" ? "response" : type === "error" ? "error" : null;
		if (!kind) {
			return null;
		}
		return { key: `${kind}:${hashString(body)}`, body };
	}

	/**
	 * Idempotency + throttle gate, then deliver. Marks the key as posted only
	 * after a successful delivery, so a failed post can be retried by a later
	 * event.
	 */
	private async deliver(
		sessionId: string,
		binding: FeishuBackflowBinding,
		dedupKey: string,
		text: string,
	): Promise<void> {
		// Idempotency: this exact milestone was already posted for this session.
		const seen = this.postedKeys.get(sessionId);
		if (seen?.has(dedupKey)) {
			this.logger.debug(
				`Skipping duplicate Feishu backflow (${dedupKey}) for session ${sessionId}`,
			);
			return;
		}

		// Throttle: identical text posted to this session moments ago.
		const hash = hashString(text);
		const last = this.lastPost.get(sessionId);
		if (
			last &&
			last.hash === hash &&
			this.now() - last.at < this.throttleWindowMs
		) {
			this.logger.debug(
				`Throttling repeated Feishu backflow for session ${sessionId}`,
			);
			return;
		}

		await this.notifier({
			rootMessageId: binding.rootMessageId,
			chatId: binding.chatId,
			text,
		});

		this.rememberKey(sessionId, dedupKey);
		this.lastPost.set(sessionId, { hash, at: this.now() });
		this.logger.info(
			`Backflowed milestone (${dedupKey}) to Feishu chat ${binding.chatId} for session ${sessionId}`,
		);
	}

	/** Record a posted key, evicting the oldest when the per-session cap is hit. */
	private rememberKey(sessionId: string, dedupKey: string): void {
		let seen = this.postedKeys.get(sessionId);
		if (!seen) {
			seen = new Set<string>();
			this.postedKeys.set(sessionId, seen);
		}
		seen.add(dedupKey);
		if (seen.size > MAX_KEYS_PER_SESSION) {
			const oldest = seen.values().next().value;
			if (oldest !== undefined) {
				seen.delete(oldest);
			}
		}
	}

	/** Clamp a body to {@link maxBodyChars}, appending an ellipsis when cut. */
	private truncate(body: string): string {
		const trimmed = body.trim();
		if (trimmed.length <= this.maxBodyChars) {
			return trimmed;
		}
		return `${trimmed.slice(0, this.maxBodyChars)}…`;
	}
}

/** Small, stable, non-cryptographic string hash (djb2) for dedup keys. */
function hashString(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = (hash * 33) ^ input.charCodeAt(i);
	}
	// Unsigned hex keeps the key short and collision-resistant enough for dedup.
	return (hash >>> 0).toString(16);
}
