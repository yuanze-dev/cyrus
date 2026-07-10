/**
 * SessionCorrelationRegistry - Centralized session storage + cross-channel correlation
 *
 * Originally the Phase 1 GlobalSessionRegistry of the CYPACK-724 refactor
 * (per-repository session storage replaced by a global registry that enables
 * cross-repository session lookups, e.g. a parent orchestrator in Repo A creating
 * child issues in Repo B).
 *
 * IN-42 §5 P0 upgrades it into a correlation base: alongside the existing
 * child→parent map it now maintains a `channelKey → sessionId` index so that an
 * incoming message from ANY channel (Feishu thread, Slack thread, Linear agent
 * session) can be resolved to the same logical session. See {@link bind} /
 * {@link resolve}. The two maps are structurally identical (`string → string`)
 * and coexist without touching legacy behavior — the correlation index is a pure
 * shadow record until later phases activate the unified `handleMessage` entry.
 *
 * The class is exported as `SessionCorrelationRegistry`; `GlobalSessionRegistry`
 * remains as a backward-compatible alias for existing imports.
 */

import { EventEmitter } from "node:events";
import type {
	CyrusAgentSession,
	CyrusAgentSessionEntry,
	SerializedCyrusAgentSession,
	SerializedCyrusAgentSessionEntry,
} from "cyrus-core";

/**
 * Serialization format for SessionCorrelationRegistry state
 * Version 3.0 to distinguish from previous per-repository format (v2.0)
 */
export interface SerializedGlobalRegistryState {
	version: "3.0";
	sessions: Record<string, SerializedCyrusAgentSession>;
	entries: Record<string, SerializedCyrusAgentSessionEntry[]>;
	childToParentMap: Record<string, string>;
	/**
	 * channelKey → sessionId correlation index (IN-42 §5 P0). Maps a stable,
	 * channel-scoped key (e.g. Feishu `chatId:threadRoot`, Linear agent session id)
	 * to the logical session it belongs to. Optional for backward compatibility
	 * with state serialized before this field existed.
	 */
	sessionChannelIndex?: Record<string, string>;
}

/**
 * Events emitted by GlobalSessionRegistry
 */
export interface GlobalSessionRegistryEvents {
	sessionCreated: (session: CyrusAgentSession) => void;
	sessionUpdated: (
		sessionId: string,
		session: CyrusAgentSession,
		updates: Partial<CyrusAgentSession>,
	) => void;
	sessionCompleted: (sessionId: string, session: CyrusAgentSession) => void;
}

/**
 * GlobalSessionRegistry centralizes all session storage across repositories.
 *
 * Responsibilities:
 * - Store ALL CyrusAgentSession objects (all repos)
 * - Store ALL CyrusAgentSessionEntry arrays (all repos)
 * - Maintain parent-child session relationships
 * - Emit lifecycle events for session changes
 * - Support serialization/deserialization for persistence
 * - Provide cleanup for old sessions
 */
export class SessionCorrelationRegistry extends EventEmitter {
	/**
	 * All sessions keyed by session id
	 */
	private sessions: Map<string, CyrusAgentSession> = new Map();

	/**
	 * All entries keyed by session id
	 */
	private entries: Map<string, CyrusAgentSessionEntry[]> = new Map();

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
	 *
	 * Structurally identical to {@link childToParentMap}; coexists with it without
	 * affecting legacy behavior.
	 */
	private channelToSessionMap: Map<string, string> = new Map();

	/**
	 * Create a new session in the registry
	 * @param session The session to create
	 * @throws Error if session with same ID already exists
	 */
	createSession(session: CyrusAgentSession): void {
		if (this.sessions.has(session.id)) {
			throw new Error(`Session with ID ${session.id} already exists`);
		}

		this.sessions.set(session.id, session);
		this.entries.set(session.id, []);

		this.emit("sessionCreated", session);
	}

	/**
	 * Get a session by ID
	 * @param sessionId The session id
	 * @returns The session or undefined if not found
	 */
	getSession(sessionId: string): CyrusAgentSession | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * Update a session with partial data
	 * @param sessionId The session id
	 * @param updates Partial session data to merge
	 * @throws Error if session doesn't exist
	 */
	updateSession(sessionId: string, updates: Partial<CyrusAgentSession>): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session with ID ${sessionId} not found`);
		}

		const oldStatus = session.status;
		const updatedSession = { ...session, ...updates, updatedAt: Date.now() };
		this.sessions.set(sessionId, updatedSession);

		this.emit("sessionUpdated", sessionId, updatedSession, updates);

		// Emit completion event if status changed to complete/error
		if (
			oldStatus !== updatedSession.status &&
			(updatedSession.status === "complete" ||
				updatedSession.status === "error")
		) {
			this.emit("sessionCompleted", sessionId, updatedSession);
		}
	}

	/**
	 * Delete a session and its entries
	 * @param sessionId The session id
	 */
	deleteSession(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.entries.delete(sessionId);

		// Clean up any parent-child mappings
		this.childToParentMap.delete(sessionId);
		const childMappings = Array.from(this.childToParentMap.entries());
		for (const [childId, parentId] of childMappings) {
			if (parentId === sessionId) {
				this.childToParentMap.delete(childId);
			}
		}

		// Clean up any channel correlations pointing at this session
		const channelMappings = Array.from(this.channelToSessionMap.entries());
		for (const [channelKey, boundSessionId] of channelMappings) {
			if (boundSessionId === sessionId) {
				this.channelToSessionMap.delete(channelKey);
			}
		}
	}

	/**
	 * Get all sessions
	 * @returns Array of all sessions
	 */
	getAllSessions(): CyrusAgentSession[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Add an entry to a session's conversation history
	 * @param sessionId The session id
	 * @param entry The entry to add
	 * @throws Error if session doesn't exist
	 */
	addEntry(sessionId: string, entry: CyrusAgentSessionEntry): void {
		if (!this.sessions.has(sessionId)) {
			throw new Error(`Session with ID ${sessionId} not found`);
		}

		const sessionEntries = this.entries.get(sessionId) || [];
		sessionEntries.push(entry);
		this.entries.set(sessionId, sessionEntries);

		// Update session's updatedAt timestamp
		const session = this.sessions.get(sessionId);
		if (session) {
			session.updatedAt = Date.now();
		}
	}

	/**
	 * Get all entries for a session
	 * @param sessionId The session id
	 * @returns Array of entries (empty if session has no entries or doesn't exist)
	 */
	getEntries(sessionId: string): CyrusAgentSessionEntry[] {
		return this.entries.get(sessionId) || [];
	}

	/**
	 * Update an entry in a session's conversation history
	 * @param sessionId The session id
	 * @param entryIndex The index of the entry to update (0-based)
	 * @param updates Partial entry data to merge
	 * @throws Error if session doesn't exist or index out of bounds
	 */
	updateEntry(
		sessionId: string,
		entryIndex: number,
		updates: Partial<CyrusAgentSessionEntry>,
	): void {
		const sessionEntries = this.entries.get(sessionId);
		if (!sessionEntries) {
			throw new Error(`Session with ID ${sessionId} not found`);
		}

		if (entryIndex < 0 || entryIndex >= sessionEntries.length) {
			throw new Error(
				`Entry index ${entryIndex} out of bounds for session ${sessionId} (length: ${sessionEntries.length})`,
			);
		}

		const existingEntry = sessionEntries[entryIndex]!; // Safe: bounds checked above
		const updatedEntry: CyrusAgentSessionEntry = {
			...existingEntry,
			...updates,
			// Ensure required fields are never undefined
			type: updates.type ?? existingEntry.type,
			content: updates.content ?? existingEntry.content,
		};
		sessionEntries[entryIndex] = updatedEntry;

		// Update session's updatedAt timestamp
		const session = this.sessions.get(sessionId);
		if (session) {
			session.updatedAt = Date.now();
		}
	}

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

	/**
	 * Get all child session IDs for a parent session
	 * @param parentSessionId The parent's session id
	 * @returns Array of child session IDs
	 */
	getChildSessionIds(parentSessionId: string): string[] {
		const childIds: string[] = [];
		const childMappings = Array.from(this.childToParentMap.entries());
		for (const [childId, parentId] of childMappings) {
			if (parentId === parentSessionId) {
				childIds.push(childId);
			}
		}
		return childIds;
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
	 * Remove a channel key binding.
	 * @param channelKey The channel key to unbind
	 * @returns true if a binding was removed, false if the key was not bound
	 */
	unbind(channelKey: string): boolean {
		return this.channelToSessionMap.delete(channelKey);
	}

	/**
	 * Get all channel keys currently bound to a session id.
	 * @param sessionId The session id
	 * @returns Array of channel keys mapping to this session (empty if none)
	 */
	getChannelKeysForSession(sessionId: string): string[] {
		const keys: string[] = [];
		for (const [channelKey, boundSessionId] of this.channelToSessionMap) {
			if (boundSessionId === sessionId) {
				keys.push(channelKey);
			}
		}
		return keys;
	}

	/**
	 * Serialize the registry state for persistence
	 * Excludes non-serializable data like agentRunner instances
	 * @returns Serialized state
	 */
	serializeState(): SerializedGlobalRegistryState {
		const serializedSessions: Record<string, SerializedCyrusAgentSession> = {};
		const sessionEntries = Array.from(this.sessions.entries());
		for (const [sessionId, session] of sessionEntries) {
			// Exclude non-serializable agentRunner
			const { agentRunner: _agentRunner, ...serializableSession } = session;
			serializedSessions[sessionId] = serializableSession;
		}

		const serializedEntries: Record<
			string,
			SerializedCyrusAgentSessionEntry[]
		> = Object.fromEntries(Array.from(this.entries.entries()));

		const serializedChildToParent: Record<string, string> = Object.fromEntries(
			Array.from(this.childToParentMap.entries()),
		);

		const serializedChannelIndex: Record<string, string> = Object.fromEntries(
			Array.from(this.channelToSessionMap.entries()),
		);

		return {
			version: "3.0",
			sessions: serializedSessions,
			entries: serializedEntries,
			childToParentMap: serializedChildToParent,
			sessionChannelIndex: serializedChannelIndex,
		};
	}

	/**
	 * Restore the registry state from serialized data
	 * Clears existing state before restoring
	 * @param state Serialized state to restore
	 */
	restoreState(state: SerializedGlobalRegistryState): void {
		// Clear existing state
		this.sessions.clear();
		this.entries.clear();
		this.childToParentMap.clear();
		this.channelToSessionMap.clear();

		// Restore sessions (migrate old sessions without repositories field)
		for (const [sessionId, session] of Object.entries(state.sessions)) {
			const migrated: CyrusAgentSession = {
				...(session as CyrusAgentSession),
				repositories: (session as CyrusAgentSession).repositories ?? [],
			};
			this.sessions.set(sessionId, migrated);
		}

		// Restore entries
		for (const [sessionId, entries] of Object.entries(state.entries)) {
			this.entries.set(sessionId, entries as CyrusAgentSessionEntry[]);
		}

		// Restore parent-child mapping
		for (const [childId, parentId] of Object.entries(state.childToParentMap)) {
			this.childToParentMap.set(childId, parentId);
		}

		// Restore channel correlation index (optional; absent in pre-P0 state)
		if (state.sessionChannelIndex) {
			for (const [channelKey, sessionId] of Object.entries(
				state.sessionChannelIndex,
			)) {
				this.channelToSessionMap.set(channelKey, sessionId);
			}
		}
	}

	/**
	 * Clean up old sessions based on age
	 * Removes sessions where updatedAt is older than maxAgeMs
	 * @param maxAgeMs Maximum age in milliseconds (sessions older than this are removed)
	 * @returns Number of sessions removed
	 */
	cleanup(maxAgeMs: number): number {
		const now = Date.now();
		const cutoffTime = now - maxAgeMs;
		let removedCount = 0;

		const sessionEntries = Array.from(this.sessions.entries());
		for (const [sessionId, session] of sessionEntries) {
			if (session.updatedAt < cutoffTime) {
				this.deleteSession(sessionId);
				removedCount++;
			}
		}

		return removedCount;
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
