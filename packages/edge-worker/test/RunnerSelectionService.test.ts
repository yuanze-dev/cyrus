import type { EdgeWorkerConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

function service(config: Partial<EdgeWorkerConfig> = {}) {
	return new RunnerSelectionService({
		cyrusHome: "/tmp/cyrus",
		repositories: [],
		...config,
	} as EdgeWorkerConfig);
}

describe("RunnerSelectionService Feishu routing", () => {
	it("uses prefix over user and chat mappings", () => {
		const selection = service({
			defaultRunner: "claude",
			feishuUserRunners: { ou_user: "claude" },
			feishuChatRunners: { oc_chat: "claude" },
		}).determineFeishuRunnerSelection({
			prefixRunner: "codex",
			openId: "ou_user",
			chatId: "oc_chat",
		});

		expect(selection).toBe("codex");
	});

	it("uses user mapping before chat mapping", () => {
		const selection = service({
			defaultRunner: "claude",
			feishuUserRunners: { ou_user: "codex" },
			feishuChatRunners: { oc_chat: "claude" },
		}).determineFeishuRunnerSelection({
			openId: "ou_user",
			chatId: "oc_chat",
		});

		expect(selection).toBe("codex");
	});

	it("uses chat mapping before global default", () => {
		const selection = service({
			defaultRunner: "claude",
			feishuChatRunners: { oc_chat: "codex" },
		}).determineFeishuRunnerSelection({ chatId: "oc_chat" });

		expect(selection).toBe("codex");
	});

	it("falls back to default runner when no Feishu route matches", () => {
		const selection = service({
			defaultRunner: "codex",
		}).determineFeishuRunnerSelection({ chatId: "oc_other" });

		expect(selection).toBe("codex");
	});

	it("uses Feishu-created issue runner unless description has an explicit agent tag", () => {
		const runnerSelection = service({ defaultRunner: "claude" });
		runnerSelection.recordFeishuCreatedIssueRunner({
			issueIdentifier: "IN-42",
			issueId: "issue-42",
			runnerType: "codex",
		});

		expect(
			runnerSelection.determineRunnerSelection([], "Build it", {
				issueIdentifier: "IN-42",
			}).runnerType,
		).toBe("codex");
		expect(
			runnerSelection.determineRunnerSelection(
				[],
				"[agent=claude]\n\nBuild it",
				{
					issueIdentifier: "IN-42",
				},
			).runnerType,
		).toBe("claude");
	});
});
