import { describe, expect, it } from "vitest";
import {
	hasAgentTag,
	injectAgentTagIntoDescription,
	injectAgentTagIntoLinearSaveIssueInput,
	stripFeishuRunnerPrefix,
} from "../src/FeishuRunnerRouting.js";

describe("Feishu runner routing helpers", () => {
	it("parses and strips leading runner prefixes case-insensitively", () => {
		expect(stripFeishuRunnerPrefix("/Codex 帮我做")).toEqual({
			runnerType: "codex",
			text: "帮我做",
		});
		expect(stripFeishuRunnerPrefix("/claude")).toEqual({
			runnerType: "claude",
			text: "",
		});
	});

	it("does not parse non-leading runner prefixes", () => {
		expect(stripFeishuRunnerPrefix("帮我 /codex 做")).toEqual({
			text: "帮我 /codex 做",
		});
	});

	it("injects a half-width agent tag only when missing", () => {
		expect(injectAgentTagIntoDescription("Do work", "claude")).toBe(
			"[agent=claude]\n\nDo work",
		);
		expect(
			injectAgentTagIntoDescription("[agent=claude]\n\nDo work", "codex"),
		).toBe("[agent=claude]\n\nDo work");
		expect(hasAgentTag("\\[agent=codex\\]\n\nDo work")).toBe(true);
	});

	it("updates Linear save_issue input with the source runner tag", () => {
		expect(
			injectAgentTagIntoLinearSaveIssueInput(
				{ title: "Task", description: "Build it" },
				"claude",
			),
		).toEqual({
			title: "Task",
			description: "[agent=claude]\n\nBuild it",
		});
	});
});
