import type { RunnerType } from "cyrus-core";

export interface FeishuRunnerCommandResult {
	runnerType?: RunnerType;
	text: string;
}

const FEISHU_RUNNER_PREFIX_RE = /^\/(claude|codex)(?:\s+|$)/i;
const AGENT_TAG_RE = /\\?\[agent=[a-zA-Z0-9_.:/-]+\\?\]/i;

export function stripFeishuRunnerPrefix(
	text: string,
): FeishuRunnerCommandResult {
	const match = text.match(FEISHU_RUNNER_PREFIX_RE);
	if (!match) {
		return { text };
	}
	return {
		runnerType: match[1]!.toLowerCase() as RunnerType,
		text: text.slice(match[0].length).trimStart(),
	};
}

export function hasAgentTag(description: string): boolean {
	return AGENT_TAG_RE.test(description);
}

export function injectAgentTagIntoDescription(
	description: unknown,
	runnerType: RunnerType,
): string {
	const text = typeof description === "string" ? description : "";
	if (hasAgentTag(text)) {
		return text;
	}
	const tag = `[agent=${runnerType}]`;
	return text.trim() ? `${tag}\n\n${text}` : tag;
}

export function injectAgentTagIntoLinearSaveIssueInput(
	input: Record<string, unknown>,
	runnerType: RunnerType,
): Record<string, unknown> {
	return {
		...input,
		description: injectAgentTagIntoDescription(input.description, runnerType),
	};
}
