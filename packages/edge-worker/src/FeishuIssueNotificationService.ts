import type { ILogger, SerializedFeishuIssueBinding } from "cyrus-core";
import { createLogger } from "cyrus-core";

/**
 * Source context captured when a Feishu (Lark) thread creates a Linear issue.
 * Everything needed to reach back into the originating thread later.
 */
export interface FeishuIssueBindingInput {
	/** Linear issue human identifier, e.g. "IN-42". */
	issueIdentifier: string;
	/** Linear issue UUID, when it could be resolved. */
	issueId?: string;
	/** Issue title (best-effort). */
	issueTitle?: string;
	/** Linear issue URL (best-effort). */
	issueUrl?: string;
	/** Feishu chat id (e.g. "oc_..."). */
	chatId: string;
	/** Requester's Feishu open_id (e.g. "ou_..."). */
	openId: string;
	/** Requester's display name, when known. */
	userName?: string;
	/** Feishu thread-root message id (e.g. "om_...") to reply to. */
	rootMessageId: string;
}

/**
 * Posts a completion notice into a Feishu thread. Implemented by the caller
 * (EdgeWorker) so this service stays free of Feishu transport/token concerns and
 * is trivially unit-testable. Should throw on failure so the notification isn't
 * marked as delivered.
 */
export type FeishuThreadNotifier = (params: {
	/** Thread-root message id to reply to (kept in-thread via reply_in_thread). */
	rootMessageId: string;
	/** Chat id, for logging/diagnostics. */
	chatId: string;
	/** Plain-text message body. */
	text: string;
}) => Promise<void>;

export interface FeishuIssueNotificationServiceDeps {
	/** Delivers the composed notice into the Feishu thread. */
	notifier: FeishuThreadNotifier;
	/**
	 * Invoked after any mutation to the binding set, so the owner can persist the
	 * updated state. Optional — omitted in tests that don't exercise persistence.
	 */
	onChange?: () => void;
	logger?: ILogger;
	/** Injectable clock (epoch ms) for deterministic tests. Defaults to Date.now. */
	now?: () => number;
}

/**
 * Tracks Linear issues that originated from a Feishu (Lark) thread and notifies
 * the originating thread when such an issue is completed in Linear.
 *
 * Bindings are keyed by the Linear issue identifier (e.g. "IN-42"); see
 * {@link SerializedFeishuIssueBinding} for why the identifier — not the UUID —
 * is the primary key. Notifications are idempotent: the first successful notice
 * stamps `notifiedAt`, and subsequent completion events for the same issue are
 * ignored.
 */
export class FeishuIssueNotificationService {
	private readonly bindings = new Map<string, SerializedFeishuIssueBinding>();
	private readonly notifier: FeishuThreadNotifier;
	private readonly onChange?: () => void;
	private readonly now: () => number;
	private readonly logger: ILogger;

	constructor(deps: FeishuIssueNotificationServiceDeps) {
		this.notifier = deps.notifier;
		this.onChange = deps.onChange;
		this.now = deps.now ?? (() => Date.now());
		this.logger =
			deps.logger ??
			createLogger({ component: "FeishuIssueNotificationService" });
	}

	/**
	 * Record (or refresh) the binding for a Feishu-originated Linear issue.
	 *
	 * Source context (chat/open_id/thread root) and an existing `notifiedAt` are
	 * preserved across repeated captures of the same issue; only missing issue
	 * metadata (UUID/title/URL) is backfilled. This keeps a later `save_issue`
	 * update from clobbering the original requester or re-arming a sent notice.
	 */
	recordIssueBinding(input: FeishuIssueBindingInput): void {
		const key = input.issueIdentifier;
		if (!key) {
			return;
		}
		const existing = this.bindings.get(key);
		if (existing) {
			const merged: SerializedFeishuIssueBinding = { ...existing };
			if (!merged.issueId && input.issueId) merged.issueId = input.issueId;
			if (input.issueTitle) merged.issueTitle = input.issueTitle;
			if (input.issueUrl) merged.issueUrl = input.issueUrl;
			this.bindings.set(key, merged);
		} else {
			this.bindings.set(key, {
				issueIdentifier: input.issueIdentifier,
				issueId: input.issueId,
				issueTitle: input.issueTitle,
				issueUrl: input.issueUrl,
				chatId: input.chatId,
				openId: input.openId,
				userName: input.userName,
				rootMessageId: input.rootMessageId,
			});
			this.logger.info(
				`Recorded Feishu→Linear binding for ${input.issueIdentifier} (chat ${input.chatId}, requester ${input.openId})`,
			);
		}
		this.onChange?.();
	}

	/**
	 * Notify the originating Feishu thread that an issue reached a terminal state.
	 *
	 * Generalizes the original completion-only notice (IN-42 §Q4 / §5 P4): a
	 * `completed` issue reports success, a `canceled` issue reports cancellation.
	 * The single persisted `notifiedAt` stamp makes this idempotent across
	 * repeated webhooks — an issue has exactly one terminal transition, so the
	 * first delivered notice wins.
	 *
	 * Returns true only when a notice was actually posted. Returns false — without
	 * side effects — when the issue wasn't Feishu-originated (no binding) or was
	 * already notified. When delivery throws, the binding is left un-stamped so a
	 * later event can retry, and the error is re-thrown to the caller.
	 */
	async notifyIssueStateChange(params: {
		issueIdentifier: string;
		issueId?: string;
		title?: string;
		url?: string;
		/** Terminal state that triggered the notice. Defaults to "completed". */
		stateType?: "completed" | "canceled";
	}): Promise<boolean> {
		const stateType = params.stateType ?? "completed";
		const binding = this.lookup(params.issueIdentifier, params.issueId);
		if (!binding) {
			return false;
		}
		if (binding.notifiedAt) {
			this.logger.debug(
				`Skipping duplicate Feishu ${stateType} notice for ${binding.issueIdentifier} (already notified)`,
			);
			return false;
		}

		const title = params.title || binding.issueTitle || binding.issueIdentifier;
		const url = params.url || binding.issueUrl;
		const text = this.composeStateMessage(binding, stateType, title, url);

		await this.notifier({
			rootMessageId: binding.rootMessageId,
			chatId: binding.chatId,
			text,
		});

		binding.notifiedAt = this.now();
		this.bindings.set(binding.issueIdentifier, binding);
		this.onChange?.();
		this.logger.info(
			`Posted Feishu ${stateType} notice for ${binding.issueIdentifier} to chat ${binding.chatId}`,
		);
		return true;
	}

	/**
	 * Backward-compatible wrapper for the completion case.
	 * @see notifyIssueStateChange
	 */
	async notifyIssueCompleted(params: {
		issueIdentifier: string;
		issueId?: string;
		title?: string;
		url?: string;
	}): Promise<boolean> {
		return this.notifyIssueStateChange({ ...params, stateType: "completed" });
	}

	/** Look up a binding by identifier, falling back to a UUID scan. */
	private lookup(
		issueIdentifier: string | undefined,
		issueId: string | undefined,
	): SerializedFeishuIssueBinding | undefined {
		if (issueIdentifier) {
			const byIdentifier = this.bindings.get(issueIdentifier);
			if (byIdentifier) {
				return byIdentifier;
			}
		}
		if (issueId) {
			for (const binding of this.bindings.values()) {
				if (binding.issueId === issueId) {
					return binding;
				}
			}
		}
		return undefined;
	}

	/**
	 * Compose the plain-text terminal-state notice. Feishu text messages do NOT
	 * render Markdown, so this uses bare URLs (which auto-link) and plain lines.
	 * The requester's name is included as text — not an @mention — to make clear
	 * whom it is for without triggering an extra push notification.
	 */
	private composeStateMessage(
		binding: SerializedFeishuIssueBinding,
		stateType: "completed" | "canceled",
		title: string,
		url: string | undefined,
	): string {
		const who = binding.userName ? `${binding.userName}，` : "";
		const headline =
			stateType === "canceled"
				? `${who}你在飞书发起并转到 Linear 执行的任务已取消 🚫`
				: `${who}你在飞书发起并转到 Linear 执行的任务已完成 ✅`;
		const lines = [headline, `任务：${title}`];
		lines.push(url ? url : `任务编号：${binding.issueIdentifier}`);
		return lines.join("\n");
	}

	/** Whether a binding exists for the given identifier (test/diagnostic helper). */
	hasBinding(issueIdentifier: string): boolean {
		return this.bindings.has(issueIdentifier);
	}

	/** Read a binding by identifier (test/diagnostic helper). */
	getBinding(
		issueIdentifier: string,
	): SerializedFeishuIssueBinding | undefined {
		return this.bindings.get(issueIdentifier);
	}

	/** Serialize the binding set for persistence. */
	serialize(): Record<string, SerializedFeishuIssueBinding> {
		return Object.fromEntries(this.bindings.entries());
	}

	/** Restore the binding set from persisted state (replaces current state). */
	restore(
		record: Record<string, SerializedFeishuIssueBinding> | undefined,
	): void {
		this.bindings.clear();
		if (!record) {
			return;
		}
		for (const [key, binding] of Object.entries(record)) {
			this.bindings.set(key, binding);
		}
	}
}
