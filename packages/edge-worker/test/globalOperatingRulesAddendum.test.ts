import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendGlobalOperatingRulesAddendum } from "../src/prompts/globalOperatingRulesAddendum.js";

describe("global operating rules addendum", () => {
	let cyrusHome: string;

	beforeEach(() => {
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-global-rules-"));
		writeFileSync(
			join(cyrusHome, "CLAUDE.md"),
			"# Global rules\n- Always attribute commits to a real person.",
			"utf8",
		);
	});

	afterEach(() => {
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	it("is a no-op for the claude runner (Claude auto-discovers CLAUDE.md)", () => {
		const base = "You are Cyrus.";
		expect(
			appendGlobalOperatingRulesAddendum(base, {
				cyrusHome,
				runnerType: "claude",
			}),
		).toBe(base);
	});

	it("is a no-op when the runner type is unknown", () => {
		const base = "You are Cyrus.";
		expect(
			appendGlobalOperatingRulesAddendum(base, {
				cyrusHome,
				runnerType: undefined,
			}),
		).toBe(base);
	});

	it("prepends the global CLAUDE.md as the highest-priority block for codex", () => {
		const result = appendGlobalOperatingRulesAddendum("You are Cyrus.", {
			cyrusHome,
			runnerType: "codex",
		});
		expect(result.startsWith(`<global_operating_rules source="`)).toBe(true);
		expect(result).toContain("Always attribute commits to a real person.");
		expect(result).toContain("</global_operating_rules>\n\nYou are Cyrus.");
	});

	it("injects for gemini and cursor as well", () => {
		for (const runnerType of ["gemini", "cursor"] as const) {
			const result = appendGlobalOperatingRulesAddendum("base", {
				cyrusHome,
				runnerType,
			});
			expect(result).toContain("# Global rules");
			expect(result.endsWith("\n\nbase")).toBe(true);
		}
	});

	it("returns just the block when there is no base prompt", () => {
		const result = appendGlobalOperatingRulesAddendum("", {
			cyrusHome,
			runnerType: "codex",
		});
		expect(result.startsWith("<global_operating_rules")).toBe(true);
		expect(result.endsWith("</global_operating_rules>")).toBe(true);
	});

	it("is a no-op when cyrusHome is missing", () => {
		expect(
			appendGlobalOperatingRulesAddendum("base", {
				cyrusHome: undefined,
				runnerType: "codex",
			}),
		).toBe("base");
	});

	it("is a no-op when <cyrusHome>/CLAUDE.md does not exist", () => {
		const emptyHome = mkdtempSync(join(tmpdir(), "cyrus-no-rules-"));
		try {
			expect(
				appendGlobalOperatingRulesAddendum("base", {
					cyrusHome: emptyHome,
					runnerType: "codex",
				}),
			).toBe("base");
		} finally {
			rmSync(emptyHome, { recursive: true, force: true });
		}
	});

	it("is a no-op when CLAUDE.md is empty/whitespace", () => {
		writeFileSync(join(cyrusHome, "CLAUDE.md"), "   \n\n", "utf8");
		expect(
			appendGlobalOperatingRulesAddendum("base", {
				cyrusHome,
				runnerType: "codex",
			}),
		).toBe("base");
	});
});
