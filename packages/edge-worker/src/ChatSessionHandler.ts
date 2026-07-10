import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SDKMessage, SdkPluginConfig } from "cyrus-claude-runner";
import type {
	AgentRunnerConfig,
	AgentSessionInfo,
	ChannelBinding,
	CyrusAgentSession,
	IAgentRunner,
	ILogger,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import { createLogger } from "cyrus-core";
import type { AgentSessionManager } from "./AgentSessionManager.js";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import type { RunnerConfigBuilder } from "./RunnerConfigBuilder.js";

/**
 * Defines what each chat platform must provide for the generic session lifecycle.
 *
 * Implementations are stateless data mappers — they translate platform-specific
 * events into the common operations the ChatSessionHandler needs.
 */
/** Platform identifiers supported by the session manager */
export type ChatPlatformName = "slack" | "linear" | "github" | "feishu";

/**
 * Sanitize a chat thread key into a filesystem-safe path segment. Shared by the
 * per-thread workspace ({@link ChatSessionHandler.createWorkspace}) and by
 * adapters that need a stable per-thread directory (e.g. Feishu image
 * attachments) so the two never derive divergent names for the same thread.
 */
export function sanitizeThreadKeyForPath(threadKey: string): string {
	return threadKey.replace(/[^a-zA-Z0-9.-]/g, "_");
}

export interface ChatTaskInstructions {
	text: string;
	requestedRunnerType?: RunnerType;
}

export interface ChatRoutingContext {
	userId?: string;
	chatId?: string;
}

export interface ChatPlatformAdapter<TEvent> {
	readonly platformName: ChatPlatformName;

	/**
	 * Extract the user's task text from the raw event. May be async — e.g. the
	 * Feishu adapter downloads any attached images here and appends references to
	 * them so the model can read them via the Read tool.
	 */
	extractTaskInstructions(
		event: TEvent,
	): string | ChatTaskInstructions | Promise<string | ChatTaskInstructions>;

	/**
	 * Whether this event is allowed to *start* a brand-new session for its
	 * thread. Events that may only continue an already-bound thread (e.g. a
	 * plain Slack message that isn't an @mention) return false, so the handler
	 * ignores them when no session exists yet.
	 *
	 * Optional — when omitted, every event is treated as session-initiating
	 * (the behaviour for platforms where every event is an explicit invocation).
	 */
	isSessionInitiatingEvent?(event: TEvent): boolean;

	/** Derive a unique thread key for session tracking (e.g., "C123:1704110400.000100") */
	getThreadKey(event: TEvent): string;

	/** Optional platform identifiers used for runner routing. */
	getRoutingContext?(event: TEvent): ChatRoutingContext;

	/**
	 * All thread keys this event could belong to (most stable first), used to
	 * reconcile a conversation whose canonical {@link getThreadKey} shifts
	 * between turns back to a single session. The first entry MUST equal
	 * `getThreadKey(event)`; the rest are treated as lookup aliases.
	 *
	 * Optional — when omitted, only `getThreadKey` identifies the thread (the
	 * behaviour for platforms with a single stable thread identity, e.g. Slack).
	 */
	getThreadAliasKeys?(event: TEvent): string[];

	/** Get the unique event ID */
	getEventId(event: TEvent): string;

	/**
	 * Build the {@link ChannelBinding} recorded on a freshly created session so
	 * the logical session carries its originating channel's identity (IN-42 §Q1).
	 * Optional — platforms that don't yet contribute a binding omit it.
	 */
	getChannelBinding?(event: TEvent): ChannelBinding | undefined;

	/** Build a platform-specific system prompt */
	buildSystemPrompt(event: TEvent): string;

	/** Fetch thread context as formatted string. Returns "" if not applicable */
	fetchThreadContext(event: TEvent): Promise<string>;

	/** Post the agent's final response back to the platform */
	postReply(event: TEvent, runner: IAgentRunner): Promise<void>;

	/** Acknowledge receipt of the event (e.g., emoji reaction). Fire-and-forget */
	acknowledgeReceipt(event: TEvent): Promise<void>;

	/**
	 * Acknowledge that the agent finished processing the event (e.g., swap the
	 * receipt reaction for a "done" one). Called after the turn completes,
	 * whether or not a reply was actually posted — this is what tells users a
	 * message was seen even when the agent chose to stay silent.
	 *
	 * Optional — platforms without a processed indicator omit it. Fire-and-forget.
	 */
	acknowledgeProcessed?(event: TEvent): Promise<void>;

	/** Notify the user that a previous request is still processing */
	notifyBusy(event: TEvent, threadKey: string): Promise<void>;

	/** Notify the user that this thread is locked to its original runner. */
	notifyRunnerLocked?(event: TEvent, runnerType: RunnerType): Promise<void>;
}

/**
 * Minimal channelKey ⇄ sessionId correlation surface the handler needs.
 * Satisfied by {@link SessionCorrelationRegistry}. Kept narrow so the binding
 * survives a process restart (the registry is persisted) and so tests can pass
 * a lightweight fake.
 */
export interface ChatSessionCorrelation {
	bind(channelKey: string, sessionId: string): void;
	resolve(channelKey: string): string | undefined;
}

/**
 * Callbacks for EdgeWorker integration (same pattern as RepositoryRouterDeps).
 */
export interface ChatSessionHandlerDeps {
	cyrusHome: string;
	/**
	 * Shared singleton {@link AgentSessionManager} (IN-42 §5 P1). Chat sessions
	 * are stored here — the same instance that holds Linear/GitHub sessions — so
	 * they serialize with the rest of EdgeWorker state and survive restarts,
	 * instead of living in a per-handler in-memory manager that was lost on exit.
	 */
	agentSessionManager: AgentSessionManager;
	/**
	 * Persisted channelKey → sessionId correlation. On create the handler binds
	 * the thread's canonical key (and aliases) here; on a later turn — including
	 * after a restart wiped the in-memory maps — it resolves the thread back to
	 * its original session through this registry.
	 */
	correlationRegistry: ChatSessionCorrelation;
	/** Provider for live repository paths, default repo, and workspace ID */
	chatRepositoryProvider: ChatRepositoryProvider;
	/** Shared RunnerConfigBuilder for constructing runner configs */
	runnerConfigBuilder: RunnerConfigBuilder;
	/** Factory function that creates the appropriate runner based on config.defaultRunner */
	createRunner: (
		config: AgentRunnerConfig,
		context?: { runnerType?: RunnerType },
	) => IAgentRunner;
	resolveRunnerType?: (input: {
		event: unknown;
		requestedRunnerType?: RunnerType;
		routingContext?: ChatRoutingContext;
	}) => RunnerType;
	/**
	 * Live read of the workspace-level custom-integration MCP config paths
	 * for the chat platform this handler is bound to (e.g.
	 * `config.slackMcpConfigs` for Slack). Chat sessions are repo-agnostic,
	 * so `repository.mcpConfigPath` is not consulted; only this list
	 * determines which custom `.mcp.json` files load. When empty/omitted,
	 * no custom files load (native MCP servers still run as usual).
	 */
	getPlatformMcpConfigOverrides?: () => readonly string[] | undefined;
	/** Resolve managed skill plugins and scoped skill names for a chat session. */
	resolveSkillsConfig?: (input: {
		repository?: RepositoryConfig;
		repositoryPaths: string[];
	}) => Promise<{ plugins?: SdkPluginConfig[]; skills?: string[] | "all" }>;
	/**
	 * Run this platform's chat sessions as full-capability agents — the
	 * complete tool set plus unrestricted host filesystem access — instead of
	 * the read-only chat default. Set by the Feishu front door via the
	 * `FEISHU_FULL_ACCESS` env var. SECURITY: grants arbitrary command
	 * execution to anyone who can message the bot.
	 */
	fullAccess?: boolean;
	/**
	 * Cross-channel injection hook (IN-42 §5 P3). Invoked when a thread resolves —
	 * via the persisted {@link correlationRegistry} — to a session this chat
	 * handler does NOT own (e.g. a Linear agent session the thread was bound to
	 * when it created the issue). Rather than driving the follow-up as a local
	 * chat session (which would build a chat system prompt and reply to the wrong
	 * place), the handler hands it to EdgeWorker, which serializes it onto the
	 * target session's queue, checks authorization (红线), leaves a Linear-side
	 * trace, and injects it into the foreign session's runner.
	 *
	 * Optional — omitted (undefined) keeps the handler's legacy same-channel-only
	 * behavior, which is how the feature stays flag-gated and reversible.
	 */
	onForeignSessionPrompt?: (params: {
		sessionId: string;
		event: unknown;
		threadKey: string;
		text: string;
	}) => Promise<void>;
	onWebhookStart: () => void;
	onWebhookEnd: () => void;
	onStateChange: () => Promise<void>;
	onClaudeError: (error: Error) => void;
}

/**
 * Generic session lifecycle engine for chat platform integrations.
 *
 * Manages the create/resume/inject/reply session lifecycle independent of any
 * specific chat platform. Platform-specific behavior is provided via a
 * ChatPlatformAdapter.
 */
export class ChatSessionHandler<TEvent> {
	private adapter: ChatPlatformAdapter<TEvent>;
	// Shared singleton AgentSessionManager (injected via deps), NOT a private
	// per-handler instance — see constructor / IN-42 §5 P1.
	private sessionManager: AgentSessionManager;
	// Persisted channelKey → sessionId correlation (injected via deps). Lets a
	// thread re-merge to its original session after a restart clears the
	// in-memory threadSessions/threadAliases maps below.
	private correlationRegistry: ChatSessionCorrelation;
	// Canonical thread key → sessionId. One entry per session (the key it was
	// created under), so `listThreads()`/`getRunnerForThread()` stay 1:1.
	private threadSessions: Map<string, string> = new Map();
	// Secondary thread keys (see ChatPlatformAdapter.getThreadAliasKeys) →
	// sessionId. A conversation whose canonical key shifts between turns (e.g. a
	// Feishu @mention keyed on messageId, then in-topic follow-ups keyed on
	// thread_id) resolves through here to the ORIGINAL session instead of
	// spawning a second, zero-history one. Kept separate from threadSessions so
	// the canonical map remains one entry per session.
	private threadAliases: Map<string, string> = new Map();
	private deps: ChatSessionHandlerDeps;
	private logger: ILogger;
	// Queue of events awaiting a reply, keyed by sessionId. Each entry is
	// enqueued when a new prompt (initial/resume/follow-up-inject) is sent to
	// the runner, and the queue is drained when a `result` message arrives on
	// the runner's message stream. This decouples reply posting from
	// `startStreaming()` resolution, which never resolves when warm sessions
	// hold the streaming prompt open across turns.
	//
	// Drained wholesale, NOT one-per-result: messages injected in quick
	// succession get merged by the runner into a single turn (one `result`
	// answering several queued prompts), so a strict FIFO pairing would leave
	// orphaned entries that never get acknowledged — and would pair them with
	// the wrong later turns.
	private pendingReplyEvents: Map<string, TEvent[]> = new Map();
	// Last event enqueued per session. When a merged turn drained the queue
	// ahead of schedule, a subsequent `result` finds the queue empty — this
	// remembers where to post that turn's reply (all events in a session share
	// one thread, so any recent event addresses it correctly).
	private lastReplyEvent: Map<string, TEvent> = new Map();
	// Follow-up events that arrived while a turn was running and could not be
	// streamed into it (e.g. the exec Codex backend, which has no mid-turn input
	// channel). Keyed by sessionId (NOT threadKey — a session may be addressed by
	// several alias keys, so keying by the stable sessionId avoids queue/drain
	// mismatches). Drained when the running turn completes and re-dispatched as a
	// fresh turn, so a follow-up is never silently dropped — honoring the "I'll
	// pick up your new message once I'm done" promise.
	private pendingFollowups: Map<string, TEvent[]> = new Map();

	constructor(
		adapter: ChatPlatformAdapter<TEvent>,
		deps: ChatSessionHandlerDeps,
		logger?: ILogger,
	) {
		this.adapter = adapter;
		this.deps = deps;
		this.logger = logger ?? createLogger({ component: "ChatSessionHandler" });

		// Chat sessions live in the shared singleton AgentSessionManager (IN-42 §5
		// P1) so they persist and restore alongside the rest of EdgeWorker state.
		// A per-handler private manager was previously used here, but its sessions
		// were memory-only and lost on restart.
		this.sessionManager = deps.agentSessionManager;
		this.correlationRegistry = deps.correlationRegistry;
	}

	/**
	 * Main entry point — handles a single chat platform event.
	 *
	 * Replaces the per-platform handleXxxWebhook method in EdgeWorker.
	 */
	async handleEvent(event: TEvent): Promise<void> {
		this.deps.onWebhookStart();

		try {
			this.logger.info(
				`Processing ${this.adapter.platformName} webhook: ${this.adapter.getEventId(event)}`,
			);

			const threadKey = this.adapter.getThreadKey(event);

			// Check if there's already an active session for this thread, matching
			// on the canonical key or any alias (a conversation whose canonical key
			// shifts between turns still resolves to its original session).
			const existingSessionId = this.resolveThreadSession(event, threadKey);

			// Only events explicitly allowed to *start* a session may do so — e.g.
			// a Slack/Feishu @mention. A plain message in an unbound thread (no
			// existing session) must be ignored entirely: no emoji receipt, no
			// processing. This check runs BEFORE acknowledgeReceipt so we never add
			// an "OnIt" reaction to messages we won't act on. Already-bound threads
			// (existingSessionId set) fall through so multi-turn conversations keep
			// getting acknowledged and injected.
			if (
				!existingSessionId &&
				this.adapter.isSessionInitiatingEvent?.(event) === false
			) {
				this.logger.info(
					`Ignoring non-initiating ${this.adapter.platformName} event for unbound thread ${threadKey}`,
				);
				return;
			}

			// Fire-and-forget acknowledgement (e.g., emoji reaction)
			this.adapter.acknowledgeReceipt(event).catch((err: unknown) => {
				this.logger.warn(
					`Failed to acknowledge ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
				);
			});

			// Resolve the prompt text. Deferred until after the non-initiating guard
			// so ignored events never trigger side effects (e.g. downloading images).
			const extractedInstructions = normalizeChatTaskInstructions(
				await this.adapter.extractTaskInstructions(event),
			);
			const taskInstructions = extractedInstructions.text;

			if (existingSessionId) {
				// Learn any new keys this event carries (e.g. a thread_id that only
				// appeared once the topic was born) so later turns resolve directly —
				// both in-memory and in the persisted correlation registry.
				this.registerThreadAliases(event, existingSessionId);
				this.bindThreadCorrelation(event, threadKey, existingSessionId);

				const existingSession =
					this.sessionManager.getSession(existingSessionId);
				const existingRunner =
					this.sessionManager.getAgentRunner(existingSessionId);

				// Cross-channel injection (IN-42 §5 P3): the thread resolved to a
				// session this chat handler does NOT own — a Linear agent session the
				// thread was bound to when it created the issue. Hand the follow-up to
				// EdgeWorker's cross-channel injector (serial queue + Linear-side trace
				// + authorization guard) rather than driving it as a local chat
				// session (which would build a chat system prompt and reply to the
				// wrong place). A `requestedRunnerType` is ignored here: a foreign
				// session's engine is fixed, so there is nothing to switch.
				if (
					this.deps.onForeignSessionPrompt &&
					existingSession &&
					this.isForeignSession(existingSession)
				) {
					this.logger.info(
						`Routing ${this.adapter.platformName} follow-up in thread ${threadKey} into foreign session ${existingSessionId} (cross-channel injection)`,
					);
					await this.deps.onForeignSessionPrompt({
						sessionId: existingSessionId,
						event,
						threadKey,
						text: taskInstructions,
					});
					return;
				}

				if (extractedInstructions.requestedRunnerType) {
					const lockedRunnerType =
						getLockedRunnerType(existingSession) ??
						extractedInstructions.requestedRunnerType;
					await this.adapter.notifyRunnerLocked?.(event, lockedRunnerType);
					this.adapter.acknowledgeProcessed?.(event).catch((err: unknown) => {
						this.logger.warn(
							`Failed to acknowledge processed ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
						);
					});
					return;
				}

				if (existingSession && existingRunner?.isRunning()) {
					// Session is actively running — inject the follow-up via streaming input
					if (
						existingRunner.addStreamMessage &&
						existingRunner.isStreaming?.()
					) {
						this.logger.info(
							`Injecting follow-up prompt into running session ${existingSessionId} (thread ${threadKey})`,
						);
						this.enqueueReply(existingSessionId, event);
						existingRunner.addStreamMessage(taskInstructions);
					} else {
						// Runner can't accept mid-turn input (e.g. exec Codex). Queue the
						// follow-up so it's delivered as a fresh turn once this one ends,
						// rather than dropped — then tell the user we'll pick it up.
						this.logger.info(
							`Session ${existingSessionId} is still running; queuing follow-up for after the turn (thread ${threadKey})`,
						);
						this.queuePendingFollowup(existingSessionId, event);
						await this.adapter.notifyBusy(event, threadKey);
					}
					return;
				}

				if (existingSession) {
					// Session exists but is not running — resume with --continue.
					// This covers both a completed in-process turn (runner present but
					// idle) AND a session restored after a restart (runner stripped
					// during serialization, so existingRunner is undefined). Either
					// way, as long as a persisted runner session id survives we
					// continue the SAME session rather than spawning a fresh one — the
					// key to "same thread after restart re-merges to the original
					// session" (IN-42 §5 P1).
					this.logger.info(
						`Resuming ${this.adapter.platformName} session ${existingSessionId} (thread ${threadKey}${existingRunner ? "" : ", recovered after restart"})`,
					);

					const resumeSessionId =
						existingSession.claudeSessionId ||
						existingSession.geminiSessionId ||
						existingSession.codexSessionId ||
						existingSession.cursorSessionId;

					if (resumeSessionId) {
						try {
							await this.resumeSession(
								event,
								existingSession,
								existingSessionId,
								resumeSessionId,
								taskInstructions,
							);
						} catch (error) {
							this.logger.error(
								`Failed to resume ${this.adapter.platformName} session ${existingSessionId}`,
								error instanceof Error ? error : new Error(String(error)),
							);
						}
						return;
					}
				}

				// Session exists but runner was lost — fall through to create a new session
				this.logger.info(
					`Previous session ${existingSessionId} for thread ${threadKey} has no runner, creating new session`,
				);
			}

			// No session exists for this thread (the non-initiating guard above
			// already returned for events that may only continue a bound thread).
			// Create an empty workspace directory for this thread
			const workspace = await this.createWorkspace(threadKey);
			if (!workspace) {
				this.logger.error(
					`Failed to create workspace for ${this.adapter.platformName} thread ${threadKey}`,
				);
				return;
			}

			this.logger.info(
				`${this.adapter.platformName} workspace created at: ${workspace.path}`,
			);

			// Create a chat session (not tied to any issue or repository)
			const eventId = this.adapter.getEventId(event);
			const sessionId = `${this.adapter.platformName}-${eventId}`;
			this.sessionManager.createChatSession(
				sessionId,
				workspace,
				this.adapter.platformName,
			);

			const session = this.sessionManager.getSession(sessionId);
			if (!session) {
				this.logger.error(
					`Failed to create session for ${this.adapter.platformName} webhook ${eventId}`,
				);
				return;
			}

			// Track this thread → session mapping for follow-up messages, plus any
			// alias keys so a later turn keyed differently still finds this session.
			this.threadSessions.set(threadKey, sessionId);
			this.registerThreadAliases(event, sessionId);

			// Persist the channel correlation so this thread re-merges to the same
			// session after a restart (the in-memory maps above don't survive it).
			// Binds the canonical key plus every alias key the event advertises.
			this.bindThreadCorrelation(event, threadKey, sessionId);

			// Record the originating channel identity on the logical session
			// (IN-42 §Q1) so persisted state carries where the session came from.
			const channelBinding = this.adapter.getChannelBinding?.(event);
			if (channelBinding) {
				session.channels = [channelBinding];
			}

			// Initialize session metadata
			if (!session.metadata) {
				session.metadata = {};
			}
			const runnerType = this.resolveRunnerType(
				event,
				extractedInstructions.requestedRunnerType,
			);
			(session.metadata as Record<string, unknown>).runnerType = runnerType;

			// Build the system prompt
			const systemPrompt = this.adapter.buildSystemPrompt(event);

			// Build runner config
			const runnerConfig = await this.buildRunnerConfig(
				session.workspace.path,
				sessionId,
				systemPrompt,
				sessionId,
				undefined,
				runnerType,
			);

			const runner = this.deps.createRunner(runnerConfig, { runnerType });

			// Store the runner in the session manager
			this.sessionManager.addAgentRunner(sessionId, runner);

			// Save persisted state
			await this.deps.onStateChange();

			// Fetch thread context for threaded mentions
			const threadContext = await this.adapter.fetchThreadContext(event);
			const userPrompt = threadContext
				? `${threadContext}\n\n${taskInstructions}`
				: taskInstructions;

			this.logger.info(
				`Starting runner for ${this.adapter.platformName} event ${eventId}`,
			);

			// Start in streaming mode if supported (allows follow-up message injection),
			// otherwise fall back to non-streaming start.
			//
			// Reply posting happens from handleAgentMessage() when a `result`
			// message arrives on the runner's stream — we do NOT await turn
			// completion here, because with warm sessions the streaming prompt
			// stays open and the start() promise doesn't resolve until the
			// whole session ends.
			this.enqueueReply(sessionId, event);
			const startPromise =
				runner.supportsStreamingInput && runner.startStreaming
					? runner.startStreaming(userPrompt)
					: runner.start(userPrompt);
			startPromise
				.then((sessionInfo: AgentSessionInfo) => {
					this.logger.info(
						`${this.adapter.platformName} session started: ${sessionInfo.sessionId}`,
					);
				})
				.catch((error: unknown) => {
					this.logger.error(
						`${this.adapter.platformName} session error for event ${eventId}`,
						error instanceof Error ? error : new Error(String(error)),
					);
					// Runner died before emitting a final `result`. Drop any
					// still-queued reply events for this session so a later
					// resumeSession() doesn't pair them with a future turn.
					this.clearPendingReplies(sessionId);
				})
				.finally(() => {
					this.deps.onStateChange().catch((error: unknown) => {
						this.logger.error(
							`onStateChange failed after ${this.adapter.platformName} session ${sessionId}`,
							error instanceof Error ? error : new Error(String(error)),
						);
					});
				});
		} catch (error) {
			this.logger.error(
				`Failed to process ${this.adapter.platformName} webhook`,
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.deps.onWebhookEnd();
		}
	}

	/** Returns true if any runner for a session THIS handler owns is busy */
	isAnyRunnerBusy(): boolean {
		for (const sessionId of this.getOwnedSessionIds()) {
			if (this.sessionManager.getAgentRunner(sessionId)?.isRunning()) {
				return true;
			}
		}
		return false;
	}

	/** Returns all runners for sessions THIS handler owns (for shutdown) */
	getAllRunners(): IAgentRunner[] {
		const runners: IAgentRunner[] = [];
		for (const sessionId of this.getOwnedSessionIds()) {
			const runner = this.sessionManager.getAgentRunner(sessionId);
			if (runner) {
				runners.push(runner);
			}
		}
		return runners;
	}

	/**
	 * Expose every active chat session this handler owns, so EdgeWorker can
	 * resolve a cwd → session bundle from outside (e.g. the `log_failure_mode`
	 * MCP tool needs to find a Slack/Feishu chat session's runner session id).
	 * Chat sessions now live in the shared singleton AgentSessionManager, so this
	 * scopes to the ids this handler created/resolved to avoid returning
	 * unrelated (Linear/GitHub) sessions.
	 */
	getAllChatSessions(): CyrusAgentSession[] {
		const sessions: CyrusAgentSession[] = [];
		for (const sessionId of this.getOwnedSessionIds()) {
			const session = this.sessionManager.getSession(sessionId);
			if (session) {
				sessions.push(session);
			}
		}
		return sessions;
	}

	/**
	 * Test/inspection: list all known thread keys and their session IDs.
	 * Used by F1 to discover chat sessions for follow-up prompts and replay.
	 */
	listThreads(): Array<{ threadKey: string; sessionId: string }> {
		return Array.from(this.threadSessions.entries()).map(
			([threadKey, sessionId]) => ({ threadKey, sessionId }),
		);
	}

	/**
	 * Test/inspection: resolve a chat thread to its runner. Returns undefined
	 * when the thread is unknown or the runner has been disposed.
	 */
	getRunnerForThread(threadKey: string): IAgentRunner | undefined {
		const sessionId = this.threadSessions.get(threadKey);
		if (!sessionId) return undefined;
		return this.sessionManager.getAgentRunner(sessionId);
	}

	/**
	 * Resume an existing session with a new prompt (--continue behavior).
	 */
	private async resumeSession(
		event: TEvent,
		existingSession: CyrusAgentSession,
		sessionId: string,
		resumeSessionId: string,
		taskInstructions: string,
	): Promise<void> {
		const runnerType = getLockedRunnerType(existingSession);
		const systemPrompt = this.adapter.buildSystemPrompt(event);

		const runnerConfig = await this.buildRunnerConfig(
			existingSession.workspace.path,
			sessionId,
			systemPrompt,
			sessionId,
			resumeSessionId,
			runnerType,
		);

		const runner = this.deps.createRunner(runnerConfig, { runnerType });
		this.sessionManager.addAgentRunner(sessionId, runner);

		// Reply posting is driven by `result` messages on the runner's stream
		// (see handleAgentMessage). We must not await turn completion here —
		// warm sessions hold the streaming prompt open across turns so the
		// start() promise only resolves when the whole session ends.
		this.enqueueReply(sessionId, event);
		const startPromise =
			runner.supportsStreamingInput && runner.startStreaming
				? runner.startStreaming(taskInstructions)
				: runner.start(taskInstructions);
		startPromise
			.then((sessionInfo: AgentSessionInfo) => {
				this.logger.info(
					`${this.adapter.platformName} session resumed: ${sessionInfo.sessionId} (was ${resumeSessionId})`,
				);
			})
			.catch((error: unknown) => {
				this.logger.error(
					`${this.adapter.platformName} resume session error for ${sessionId}`,
					error instanceof Error ? error : new Error(String(error)),
				);
				this.clearPendingReplies(sessionId);
			});
	}

	/**
	 * Handle agent messages for chat sessions.
	 * Routes to the dedicated AgentSessionManager, and posts a reply when the
	 * SDK emits a `result` message (signalling turn completion).
	 */
	private async handleAgentMessage(
		sessionId: string,
		message: SDKMessage,
	): Promise<void> {
		await this.sessionManager.handleClaudeMessage(sessionId, message);

		if (message.type === "result") {
			// A `result` ends the turn, and the turn has seen every prompt
			// injected so far — drain the whole queue, not just one entry
			// (quick-succession messages get merged into a single turn).
			const events = this.drainReplies(sessionId);
			const runner = this.sessionManager.getAgentRunner(sessionId);
			// Queue already drained by an earlier merged turn? The reply still
			// belongs to this session's thread — post it via the last event.
			const replyEvent = events[0] ?? this.lastReplyEvent.get(sessionId);
			if (replyEvent && runner) {
				try {
					await this.adapter.postReply(replyEvent, runner);
				} catch (error) {
					this.logger.error(
						`Failed to post ${this.adapter.platformName} reply for session ${sessionId}`,
						error instanceof Error ? error : new Error(String(error)),
					);
				}
				// Fire-and-forget processed acknowledgement for every drained
				// event (e.g., swap the receipt reaction) — runs even when
				// postReply stayed silent.
				for (const event of events) {
					this.adapter.acknowledgeProcessed?.(event).catch((err: unknown) => {
						this.logger.warn(
							`Failed to acknowledge processed ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
						);
					});
				}
			} else if (!replyEvent) {
				this.logger.warn(
					`Received result for session ${sessionId} with no pending reply event — nothing to post`,
				);
			}

			// The turn is done — deliver any follow-ups that arrived while busy.
			this.drainPendingFollowups(sessionId);
		}
	}

	private queuePendingFollowup(sessionId: string, event: TEvent): void {
		const queue = this.pendingFollowups.get(sessionId) ?? [];
		queue.push(event);
		this.pendingFollowups.set(sessionId, queue);
	}

	/**
	 * Whether `session` belongs to a different channel than this chat handler —
	 * i.e. a session this handler did not create and must not drive as a local
	 * chat session (IN-42 §5 P3). Chat sessions created here carry no
	 * `externalSessionId` and no `issueContext` (see
	 * {@link AgentSessionManager.createChatSession}); a Linear agent session
	 * always carries an `externalSessionId` (its Linear AgentSession id). That
	 * asymmetry is a reliable discriminator: any session with an
	 * `externalSessionId`, or an `issueContext.trackerId` that isn't this
	 * platform, is foreign.
	 */
	private isForeignSession(session: CyrusAgentSession): boolean {
		if (session.externalSessionId) {
			return true;
		}
		const trackerId = session.issueContext?.trackerId;
		return trackerId != null && trackerId !== this.adapter.platformName;
	}

	/**
	 * Resolve an existing session for this event by its canonical thread key or
	 * any alias key the adapter advertises. Returns undefined when no session is
	 * bound to any of them.
	 */
	private resolveThreadSession(
		event: TEvent,
		threadKey: string,
	): string | undefined {
		const direct =
			this.threadSessions.get(threadKey) ?? this.threadAliases.get(threadKey);
		if (direct) {
			return direct;
		}
		for (const aliasKey of this.adapter.getThreadAliasKeys?.(event) ?? []) {
			const sessionId =
				this.threadSessions.get(aliasKey) ?? this.threadAliases.get(aliasKey);
			if (sessionId) {
				return sessionId;
			}
		}
		// In-memory maps missed — consult the persisted correlation registry.
		// After a restart the maps start empty, but the registry (serialized in
		// EdgeWorker state) still knows this thread's session. Learn the hit back
		// into threadSessions so subsequent turns resolve directly and ownership
		// tracking (getOwnedSessionIds) sees it. Only trust bindings whose session
		// actually survived restore — a stale binding to a purged session must not
		// resurrect a ghost.
		for (const key of [
			threadKey,
			...(this.adapter.getThreadAliasKeys?.(event) ?? []),
		]) {
			const sessionId = this.correlationRegistry.resolve(key);
			if (sessionId && this.sessionManager.getSession(sessionId)) {
				this.logger.info(
					`Recovered ${this.adapter.platformName} thread ${threadKey} → session ${sessionId} from persisted correlation`,
				);
				this.threadSessions.set(threadKey, sessionId);
				return sessionId;
			}
		}
		return undefined;
	}

	/**
	 * Record every alias key this event carries as pointing at `sessionId`, so a
	 * later turn keyed on any of them resolves to the same session. Never
	 * overwrites a canonical `threadSessions` entry (thread ids are globally
	 * unique, so an alias can only ever belong to this one conversation).
	 */
	private registerThreadAliases(event: TEvent, sessionId: string): void {
		for (const aliasKey of this.adapter.getThreadAliasKeys?.(event) ?? []) {
			if (!this.threadSessions.has(aliasKey)) {
				this.threadAliases.set(aliasKey, sessionId);
			}
		}
	}

	/**
	 * Persist the thread's canonical key and every alias key into the correlation
	 * registry, all pointing at `sessionId`. This is the durable counterpart to
	 * {@link threadSessions}/{@link threadAliases}: those are in-memory and cleared
	 * on restart, while the registry is serialized in EdgeWorker state, so binding
	 * here is what lets {@link resolveThreadSession} recover the session later.
	 */
	private bindThreadCorrelation(
		event: TEvent,
		threadKey: string,
		sessionId: string,
	): void {
		this.correlationRegistry.bind(threadKey, sessionId);
		for (const aliasKey of this.adapter.getThreadAliasKeys?.(event) ?? []) {
			this.correlationRegistry.bind(aliasKey, sessionId);
		}
	}

	/**
	 * Session ids this handler owns. Because the singleton
	 * {@link AgentSessionManager} now also holds Linear/GitHub sessions, methods
	 * that used to enumerate "all sessions in my private manager" must instead
	 * scope to the chat sessions this handler created/resolved — otherwise
	 * shutdown, busy checks, and cwd resolution would sweep in unrelated sessions.
	 */
	private getOwnedSessionIds(): Set<string> {
		return new Set<string>([
			...this.threadSessions.values(),
			...this.threadAliases.values(),
		]);
	}

	/**
	 * Re-dispatch any follow-ups queued for a session while it was busy. Runs
	 * after the current turn settles (the runner has finalized), so each
	 * re-dispatched event takes the normal resume path. Any that still find the
	 * runner running re-queue themselves and are drained on the next completion.
	 */
	private drainPendingFollowups(sessionId: string): void {
		const queue = this.pendingFollowups.get(sessionId);
		if (!queue || queue.length === 0) {
			return;
		}
		this.pendingFollowups.delete(sessionId);
		// Defer so the just-finished runner has fully transitioned to not-running
		// before the follow-up is re-evaluated (otherwise it would re-queue).
		setImmediate(() => {
			for (const event of queue) {
				this.handleEvent(event).catch((error: unknown) => {
					this.logger.error(
						`Failed to re-dispatch queued ${this.adapter.platformName} follow-up (session ${sessionId})`,
						error instanceof Error ? error : new Error(String(error)),
					);
				});
			}
		});
	}

	private enqueueReply(sessionId: string, event: TEvent): void {
		const queue = this.pendingReplyEvents.get(sessionId) ?? [];
		queue.push(event);
		this.pendingReplyEvents.set(sessionId, queue);
		this.lastReplyEvent.set(sessionId, event);
	}

	private drainReplies(sessionId: string): TEvent[] {
		const queue = this.pendingReplyEvents.get(sessionId);
		if (!queue || queue.length === 0) return [];
		this.pendingReplyEvents.delete(sessionId);
		return queue;
	}

	/**
	 * Discard all queued reply events for a session. Called when the runner
	 * rejects before emitting a final `result` — without this, a later
	 * resumeSession() on the same sessionId would pair the stale events with
	 * the first `result` of the new runner.
	 */
	private clearPendingReplies(sessionId: string): void {
		this.lastReplyEvent.delete(sessionId);
		const queue = this.pendingReplyEvents.get(sessionId);
		if (!queue || queue.length === 0) return;
		this.logger.warn(
			`Discarding ${queue.length} pending ${this.adapter.platformName} reply event(s) for session ${sessionId} after runner error`,
		);
		this.pendingReplyEvents.delete(sessionId);
	}

	/**
	 * Create an empty workspace directory for a chat thread.
	 * Unlike repository-associated sessions, chat sessions use plain directories (not git worktrees).
	 */
	private async createWorkspace(
		threadKey: string,
	): Promise<{ path: string; isGitWorktree: boolean } | null> {
		try {
			const sanitizedKey = sanitizeThreadKeyForPath(threadKey);
			const workspacePath = join(
				this.deps.cyrusHome,
				`${this.adapter.platformName}-workspaces`,
				sanitizedKey,
			);

			await mkdir(workspacePath, { recursive: true });

			return { path: workspacePath, isGitWorktree: false };
		} catch (error) {
			this.logger.error(
				`Failed to create ${this.adapter.platformName} workspace for thread ${threadKey}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Build a runner config for a chat session.
	 * Delegates to RunnerConfigBuilder for config assembly.
	 */
	private async buildRunnerConfig(
		workspacePath: string,
		workspaceName: string | undefined,
		systemPrompt: string,
		sessionId: string,
		resumeSessionId?: string,
		runnerType?: RunnerType,
	): Promise<AgentRunnerConfig> {
		const sessionLogger = this.logger.withContext({
			sessionId,
			platform: this.adapter.platformName,
		});

		// Read live values from the provider at session-build time
		const provider = this.deps.chatRepositoryProvider;
		const repository = provider.getDefaultRepository();
		const repositoryPaths = provider.getRepositoryPaths();
		const skillsConfig = this.deps.resolveSkillsConfig
			? await this.deps.resolveSkillsConfig({ repository, repositoryPaths })
			: {};

		return this.deps.runnerConfigBuilder.buildChatConfig({
			workspacePath,
			workspaceName,
			systemPrompt,
			sessionId,
			resumeSessionId,
			cyrusHome: this.deps.cyrusHome,
			platformName: this.adapter.platformName,
			runnerType,
			linearWorkspaceId: provider.getDefaultLinearWorkspaceId(),
			repository,
			repositoryPaths,
			platformMcpConfigOverrides: this.deps.getPlatformMcpConfigOverrides?.(),
			plugins: skillsConfig.plugins,
			skills: skillsConfig.skills,
			fullAccess: this.deps.fullAccess,
			logger: sessionLogger,
			onMessage: (message: SDKMessage) =>
				this.handleAgentMessage(sessionId, message),
			onError: (error: Error) => this.deps.onClaudeError(error),
		});
	}

	private resolveRunnerType(
		event: TEvent,
		requestedRunnerType?: RunnerType,
	): RunnerType | undefined {
		return this.deps.resolveRunnerType?.({
			event,
			requestedRunnerType,
			routingContext: this.adapter.getRoutingContext?.(event),
		});
	}
}

function normalizeChatTaskInstructions(
	value: string | ChatTaskInstructions,
): ChatTaskInstructions {
	return typeof value === "string" ? { text: value } : value;
}

function getLockedRunnerType(
	session: CyrusAgentSession | undefined,
): RunnerType | undefined {
	const metadataRunner = session?.metadata
		? (session.metadata as Record<string, unknown>).runnerType
		: undefined;
	if (
		metadataRunner === "claude" ||
		metadataRunner === "gemini" ||
		metadataRunner === "codex" ||
		metadataRunner === "cursor"
	) {
		return metadataRunner;
	}
	if (session?.claudeSessionId) return "claude";
	if (session?.geminiSessionId) return "gemini";
	if (session?.codexSessionId) return "codex";
	if (session?.cursorSessionId) return "cursor";
	return undefined;
}
