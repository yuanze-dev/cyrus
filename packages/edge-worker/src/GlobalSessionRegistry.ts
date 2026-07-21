/**
 * SessionCorrelationRegistry - cross-channel + cross-repository session correlation
 *
 * Originally the Phase 1 GlobalSessionRegistry of the CYPACK-724 refactor, which
 * also carried a full session/entry storage API (createSession / addEntry / …).
 * That storage half was never wired into production — the single source of truth
 * for session objects is {@link AgentSessionManager} — so IN-42 §5 P6 removed it
 * as dead code. What remains are the two correlation maps that ARE used:
 *
 * - **child → parent map** (`setParentSession` / `getParentSessionId`): enables
 *   orchestrator workflows where a parent session in Repo A creates child issues
 *   in Repo B.
 * - **channelKey → sessionId index** (`bind` / `resolve`, IN-42 §5 P0): lets an
 *   incoming message from ANY channel (Feishu thread, Slack thread, Linear agent
 *   session) resolve to the same logical session. Structurally identical to the
 *   child→parent map, and coexists with it.
 *
 * Both maps are persisted via {@link serializeState} (consumed by
 * `EdgeWorker.serializeMappings`) and restored by `EdgeWorker.restoreMappings`,
 * which rebuilds them directly through `setParentSession` / `bind`.
 *
 * The class is exported as `SessionCorrelationRegistry`; `GlobalSessionRegistry`
 * remains as a backward-compatible alias for existing imports.
 */

/**
 * Serialization format for SessionCorrelationRegistry state.
 *
 * Holds only the two correlation maps. Session/entry objects are persisted
 * separately via {@link AgentSessionManager}.
 */
export interface SerializedGlobalRegistryState {
	childToParentMap: Record<string, string>;
	/**
	 * channelKey → sessionId correlation index (IN-42 §5 P0). Maps a stable,
	 * channel-scoped key (e.g. Feishu `chatId:threadRoot`, Linear agent session id)
	 * to the logical session it belongs to.
	 */
	sessionChannelIndex: Record<string, string>;
}

/**
 * SessionCorrelationRegistry maintains cross-channel and cross-repository session
 * correlation maps. It does NOT store session objects — see {@link AgentSessionManager}.
 */
export class SessionCorrelationRegistry {
	/**
	 * Child session ID → parent session ID mapping
	 * Enables orchestrator workflows where parent (Repo A) creates child (Repo B)
	 */
	private childToParentMap: Map<string, string> = new Map();

	/**
	 * channelKey → sessionId correlation index (IN-42 §5 P0).
	 *
	 * A "channelKey" is a stable, channel-scoped identifier for an incoming
	 * conversation — e.g. Feishu `chatId:threadRoot`, Slack `channel:thread_ts`,
	 * or a Linear agent session id. Multiple channelKeys (including a channel's
	 * alias keys) may point at the same logical `sessionId`, which is how a
	 * conversation that shifts its key mid-flight (Feishu `messageId` → `threadId`)
	 * still reconciles to one session.
	 */
	private channelToSessionMap: Map<string, string> = new Map();

	/**
	 * Set parent session for a child session (orchestrator workflow)
	 * @param childSessionId The child's session id
	 * @param parentSessionId The parent's session id
	 */
	setParentSession(childSessionId: string, parentSessionId: string): void {
		this.childToParentMap.set(childSessionId, parentSessionId);
	}

	/**
	 * Get parent session ID for a child session
	 * @param childSessionId The child's session id
	 * @returns The parent session ID or undefined if not found
	 */
	getParentSessionId(childSessionId: string): string | undefined {
		return this.childToParentMap.get(childSessionId);
	}

	// ==========================================================================
	// CHANNEL CORRELATION (IN-42 §5 P0)
	// ==========================================================================

	/**
	 * Bind a channel key to a logical session id.
	 *
	 * Idempotent and last-write-wins: binding an already-bound key simply
	 * overwrites the previous session id. Alias keys are supported by binding
	 * each of them to the same session id.
	 *
	 * @param channelKey Stable channel-scoped key (e.g. Feishu `chatId:threadRoot`)
	 * @param sessionId The logical session id this channel maps to
	 */
	bind(channelKey: string, sessionId: string): void {
		this.channelToSessionMap.set(channelKey, sessionId);
	}

	/**
	 * Resolve a channel key to its bound session id.
	 * @param channelKey The channel key to look up
	 * @returns The session id, or undefined if the key is not bound
	 */
	resolve(channelKey: string): string | undefined {
		return this.channelToSessionMap.get(channelKey);
	}

	/**
	 * Serialize the correlation maps for persistence.
	 * @returns Serialized state
	 */
	serializeState(): SerializedGlobalRegistryState {
		return {
			childToParentMap: Object.fromEntries(this.childToParentMap.entries()),
			sessionChannelIndex: Object.fromEntries(
				this.channelToSessionMap.entries(),
			),
		};
	}
}

/**
 * Backward-compatible alias for {@link SessionCorrelationRegistry}.
 *
 * The registry was renamed in IN-42 §5 P0 when the channel correlation index was
 * added; existing imports of `GlobalSessionRegistry` continue to work unchanged.
 *
 * @deprecated Use {@link SessionCorrelationRegistry}.
 */
export const GlobalSessionRegistry = SessionCorrelationRegistry;
/**
 * @deprecated Use {@link SessionCorrelationRegistry}.
 */
export type GlobalSessionRegistry = SessionCorrelationRegistry;
