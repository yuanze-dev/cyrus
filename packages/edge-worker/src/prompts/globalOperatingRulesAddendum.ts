import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerType } from "cyrus-core";

/**
 * Force-inject the global operating rules (`<cyrusHome>/CLAUDE.md`) into the
 * system prompt of non-Claude runners.
 *
 * Why this exists (IN-43 Phase 0 — compliance red-line):
 *   The Claude Code SDK auto-discovers `<cyrusHome>/CLAUDE.md` because the
 *   per-issue worktree lives *under* cyrusHome (e.g.
 *   `~/.cyrus/worktrees/<issue>`), and Claude's project-scope memory walks the
 *   ancestor directories looking for `CLAUDE.md`. The other runners only
 *   auto-discover *their own* memory files — Codex reads `AGENTS.md`, Gemini
 *   reads `GEMINI.md`, Cursor reads none — so none of them ever see
 *   `CLAUDE.md`. The global hard constraints (routing rules, ship whitelist,
 *   attribution requirements, etc.) therefore silently vanish the moment a
 *   session runs on anything but Claude.
 *
 *   This addendum closes that gap by reading the global `CLAUDE.md` and
 *   prepending it — as the highest-priority block — to the system prompt that
 *   Codex/Gemini/Cursor do consume (`appendSystemPrompt`).
 *
 * Claude is intentionally a no-op here: it already sees the same file via
 * automatic discovery, and re-injecting it would duplicate the content.
 */
export function appendGlobalOperatingRulesAddendum(
	existing: string | undefined | null,
	options: { cyrusHome?: string; runnerType: RunnerType | undefined },
): string {
	const base = existing ?? "";

	// Claude already discovers <cyrusHome>/CLAUDE.md via project-scope memory.
	if (options.runnerType === "claude" || options.runnerType === undefined) {
		return base;
	}
	if (!options.cyrusHome) {
		return base;
	}

	const rulesPath = join(options.cyrusHome, "CLAUDE.md");
	if (!existsSync(rulesPath)) {
		return base;
	}

	let content: string;
	try {
		content = readFileSync(rulesPath, "utf8").trim();
	} catch {
		// Best-effort: never let a read failure break session startup.
		return base;
	}
	if (content.length === 0) {
		return base;
	}

	const block = `<global_operating_rules source="${rulesPath}">
The following are global, cross-session hard constraints. They are the
highest-priority instructions in this session and take precedence over any
lower-priority guidance below. Claude runners receive these automatically via
CLAUDE.md discovery; they are injected here so this runner honors the exact
same rules.

${content}
</global_operating_rules>`;

	return base.length > 0 ? `${block}\n\n${base}` : block;
}
