import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" as const }),
		getDefaultModelForRunner: () => "",
		getDefaultFallbackModelForRunner: () => "",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

describe("RunnerConfigBuilder.buildChatConfig", () => {
	it("includes autoMemoryDirectory in allowedDirectories so the session can read existing memory files (CYPACK-1197)", () => {
		const builder = makeBuilder();
		const cyrusHome = "/tmp/cyrus-home-test";
		const workspacePath = join(cyrusHome, "slack-workspaces", "thread-x");
		const repositoryPaths = ["/repo/one", "/repo/two"];

		const config = builder.buildChatConfig({
			workspacePath,
			workspaceName: "slack-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome,
			platformName: "slack",
			repositoryPaths,
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		const expectedAutoMemoryDir = join(cyrusHome, "slack-memory");
		const expectedAttachmentsDir = join(cyrusHome, "slack-attachments");
		expect(config.autoMemoryDirectory).toBe(expectedAutoMemoryDir);
		expect(config.allowedDirectories).toEqual([
			workspacePath,
			expectedAutoMemoryDir,
			expectedAttachmentsDir,
			...repositoryPaths,
		]);
	});

	it("full-access chat sessions get the full tool set and unrestricted host filesystem access", () => {
		const seenArgs: Array<unknown[]> = [];
		const chatToolResolver: IChatToolResolver = {
			buildChatAllowedTools: (...args) => {
				seenArgs.push(args);
				const fullAccess = args[2];
				return fullAccess ? ["Read(**)", "Write(**)", "Bash"] : ["Read(**)"];
			},
		};
		const builder = new RunnerConfigBuilder(
			chatToolResolver,
			{ buildMcpConfig: () => ({}), buildMergedMcpConfigPath: () => undefined },
			{
				determineRunnerSelection: () => ({ runnerType: "claude" as const }),
				getDefaultModelForRunner: () => "",
				getDefaultFallbackModelForRunner: () => "",
			},
		);

		const config = builder.buildChatConfig({
			workspacePath: "/tmp/feishu-workspace",
			workspaceName: "feishu-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "feishu",
			fullAccess: true,
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		// fullAccess must be forwarded to the tool resolver so it swaps in the full set.
		expect(seenArgs[0]?.[2]).toBe(true);
		expect(config.allowedTools).toEqual(["Read(**)", "Write(**)", "Bash"]);
		// And the runner must be told to skip the home-directory read restrictions.
		expect(config.unrestrictedFilesystemAccess).toBe(true);
	});

	it("non-full-access chat sessions do NOT set unrestrictedFilesystemAccess", () => {
		const builder = makeBuilder();

		const config = builder.buildChatConfig({
			workspacePath: "/tmp/slack-workspace",
			workspaceName: "slack-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "slack",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		expect(config.unrestrictedFilesystemAccess).toBeUndefined();
	});

	it("passes managed skill plugins and scoped skill names to chat runner configs", () => {
		const builder = makeBuilder();
		const plugins = [{ type: "local" as const, path: "/cyrus/user-skills" }];

		const config = builder.buildChatConfig({
			workspacePath: "/tmp/slack-workspace",
			workspaceName: "slack-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "slack",
			plugins,
			skills: ["agent-browser", "test-user-skills"],
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		expect(config.plugins).toEqual(plugins);
		expect(config.skills).toEqual(["agent-browser", "test-user-skills"]);
	});
});
