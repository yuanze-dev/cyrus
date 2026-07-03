import type { IAgentRunner, ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";
import {
	buildPromptText,
	FeishuMessageService,
	FeishuReactionService,
	type FeishuThreadMessage,
	type FeishuTokenProvider,
	type FeishuWebhookEvent,
	feishuThreadRoot,
} from "cyrus-feishu-event-transport";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import type { ChatPlatformAdapter } from "./ChatSessionHandler.js";

/**
 * Sentinel the agent emits when it has decided a Feishu message does not warrant
 * a reply. `postReply` recognizes it (substring match) and stays silent.
 */
export const FEISHU_NO_RESPONSE_SENTINEL = "<<NO_RESPONSE>>";

/**
 * Route of the hosted Behaviours settings page where automatic Feishu thread
 * listening can be turned off.
 */
export const BEHAVIOURS_PAGE_ROUTE = "/settings/behaviours";

/** Feishu reaction added when a message is received and queued for processing. */
export const RECEIPT_EMOJI = "OnIt";

/** Feishu reaction added once the agent finished its turn. */
export const PROCESSED_EMOJI = "DONE";

/**
 * Feishu (Lark) implementation of ChatPlatformAdapter.
 *
 * Contains all Feishu-specific logic: prompt extraction, thread keys, system
 * prompt, thread context, reply posting, and acknowledgement reactions. Mirrors
 * SlackChatAdapter but authenticates via a short-lived tenant_access_token
 * resolved from the {@link FeishuTokenProvider} instead of a static bot token.
 */
export class FeishuChatAdapter
	implements ChatPlatformAdapter<FeishuWebhookEvent>
{
	readonly platformName = "feishu" as const;
	private repositoryProvider: ChatRepositoryProvider;
	private tokenProvider: FeishuTokenProvider | undefined;
	private repositoryRoutingContext: string;
	private behavioursPageUrl: string;
	private apiBaseUrl: string | undefined;
	private logger: ILogger;

	constructor(
		repositoryProvider: ChatRepositoryProvider,
		tokenProvider: FeishuTokenProvider | undefined,
		logger?: ILogger,
		options?: {
			repositoryRoutingContext?: string;
			cyrusAppBaseUrl?: string;
			/** Feishu open-platform base URL (feishu.cn vs larksuite.com). */
			apiBaseUrl?: string;
		},
	) {
		this.repositoryProvider = repositoryProvider;
		this.tokenProvider = tokenProvider;
		this.repositoryRoutingContext =
			options?.repositoryRoutingContext?.trim() || "";
		const appBaseUrl = options?.cyrusAppBaseUrl?.trim().replace(/\/+$/, "");
		this.behavioursPageUrl = appBaseUrl
			? `${appBaseUrl}${BEHAVIOURS_PAGE_ROUTE}`
			: "";
		this.apiBaseUrl = options?.apiBaseUrl;
		this.logger = logger ?? createLogger({ component: "FeishuChatAdapter" });
	}

	/**
	 * Resolve a Feishu tenant_access_token, or undefined when Feishu is not
	 * configured (no token provider) or minting fails.
	 */
	private async getToken(): Promise<string | undefined> {
		if (!this.tokenProvider) {
			return undefined;
		}
		try {
			return await this.tokenProvider.getTenantAccessToken();
		} catch (error) {
			this.logger.warn(
				`Failed to resolve Feishu tenant_access_token: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	extractTaskInstructions(event: FeishuWebhookEvent): string {
		return buildPromptText(event.payload) || "Ask the user for more context";
	}

	/**
	 * An explicit @mention always may start a session; a plain `message` event
	 * may only when it was upstream-gated (proxy mode confirmed the thread is
	 * bound). Mirrors SlackChatAdapter.isSessionInitiatingEvent.
	 */
	isSessionInitiatingEvent(event: FeishuWebhookEvent): boolean {
		return event.eventType === "mention" || event.upstreamGated === true;
	}

	getThreadKey(event: FeishuWebhookEvent): string {
		return `${event.payload.chatId}:${feishuThreadRoot(event.payload)}`;
	}

	getEventId(event: FeishuWebhookEvent): string {
		return event.eventId;
	}

	buildSystemPrompt(event: FeishuWebhookEvent): string {
		const repositoryPaths = Array.from(
			new Set(this.repositoryProvider.getRepositoryPaths().filter(Boolean)),
		).sort();
		const repositoryAccessSection =
			repositoryPaths.length > 0
				? `
## Repository Access
- You have read-only access to the following configured repositories:
${repositoryPaths.map((path) => `- ${path}`).join("\n")}

- If you need to inspect source code in one of these repositories, use:
  - Bash(git -C * pull)

- You are explicitly allowed to run git pull with:
  - Bash(git -C * pull)
			`
				: `
## Repository Access
- No repository paths are configured for this chat session.`;

		const stopListeningSection = this.behavioursPageUrl
			? `

## Stopping Automatic Listening
- If the user asks you to stop listening to, following, or responding in this thread:
  - Tell them automatic thread listening can be turned off on the Behaviours page: ${this.behavioursPageUrl}
  - From that point on, treat this thread as muted: stay silent (emit \`${FEISHU_NO_RESPONSE_SENTINEL}\` and nothing else) for every subsequent message until someone asks you a direct question — addressing you by name ("Cyrus, …") or with an @mention. When you resume responding, just answer — do not announce that you are listening again.`
			: "";

		return `You are participating in a Feishu (Lark) thread.

## Context
- **Requested by**: ${event.payload.user}
- **Chat**: ${event.payload.chatId}

## When to Respond (IMPORTANT)
- After you are first @mentioned, you may receive subsequent messages in this thread, not just the ones aimed at you. Do not treat every message as a request for you.
- Respond ONLY when at least one of these is true:
  1. The message asks a question you can genuinely and helpfully answer, OR
  2. Someone addresses you directly — by name ("Cyrus, …") or with an @mention.
- For anything else — side conversation between people, acknowledgements ("thanks", "👍"), status chatter, or messages clearly not directed at you — do NOT reply.
- When you should stay silent, output exactly \`${FEISHU_NO_RESPONSE_SENTINEL}\` and nothing else — no reasoning, no explanation, not a single word before or after the token.
- NEVER narrate your decision about whether to respond. Your entire output is posted verbatim to the thread — there is no private scratchpad. Either emit the bare token, or reply directly to the user's message as if the decision never happened.
- When you do respond, be genuinely helpful and concise.${stopListeningSection}

## Instructions
- You are running in a transient workspace, not associated with any code repository
- Be concise in your responses as they will be posted back to Feishu
- If the user's request involves code changes, help them plan the work and create an issue in their project tracker (see Orchestration Notes below)
- You can answer questions, provide analysis, help with planning, and assist with research
- If files need to be created or examined, they will be in your working directory
${repositoryAccessSection}
${this.repositoryRoutingContext ? `\n\n${this.repositoryRoutingContext}` : ""}

## Self-Knowledge
- If the user asks about your capabilities, features, how you work, what you can do, setup instructions, or anything related to Cyrus documentation, use the \`mcp__cyrus-docs__search_documentation\` tool to look up the answer from the official Cyrus docs.
- Always prefer searching the docs over guessing or relying on your training data for Cyrus-specific questions.

## Orchestration Notes
- If the user asks you to make repo code changes, use these steps:
  - First run \`mcp__linear__get_user\` with \`query: "me"\` to get your Linear identity.
  - Create an Issue in the user's tracker for the requested work (for example using \`mcp__linear__save_issue\`), including enough context and acceptance criteria to execute it. Default the issue status/state to "Backlog". **IMPORTANT: Never set the status to "Triage".**
  - To route the issue to a specific repository, add \`[repo=repo-name]\` to the issue description. To target a specific branch, use \`[repo=repo-name#branch-name]\`. For multiple repos: \`repos=repo1,repo2\`.
  - Assign that Issue to that same user (your own Linear user).
  - That assignment is what immediately kicks off work in your own agent session.
  - Track execution progress by searching \`mcp__cyrus-tools__linear_get_agent_sessions\` for the active session, then opening it with \`mcp__cyrus-tools__linear_get_agent_session\`.
  - To send mid-flight feedback or corrections to a running child session, use \`mcp__cyrus-tools__linear_agent_give_feedback\` with the session ID returned by \`linear_get_agent_sessions\`. This is the ONLY way to directly prompt a running child agent. \`mcp__linear__save_comment\` does NOT trigger or notify the agent in any way. Always prefer \`linear_agent_give_feedback\` when the child agent is actively working.

## Feishu Message Formatting (CRITICAL)
Your response is posted as a Feishu (Lark) **plain-text** message. Feishu text messages do NOT render Markdown. You MUST follow these rules:

NEVER use any of the following — they do not render in Feishu and will appear as broken plain text:
- NO tables (no | --- | syntax — use plain lines or dashes instead)
- NO Markdown headers (no # syntax — use a plain line, optionally in ALL CAPS or ending with a colon)
- NO [text](url) links — write the URL inline as plain text
- NO **bold** / *italic* / \`inline code\` markup — write plain words

Supported:
- Plain text with real newlines
- Simple lists using "- item" or "1. item" on their own lines
- Bare URLs (they auto-link)
- Emoji`;
	}

	async fetchThreadContext(event: FeishuWebhookEvent): Promise<string> {
		// Only Feishu native threads (thread_id) can be listed for prior context.
		const threadId = event.payload.threadId;
		if (!threadId) {
			return "";
		}

		const token = await this.getToken();
		if (!token) {
			this.logger.warn(
				"Cannot fetch Feishu thread context: no tenant_access_token available",
			);
			return "";
		}

		try {
			const service = new FeishuMessageService(this.apiBaseUrl);
			const messages = await service.fetchThreadMessages({
				token,
				threadId,
				limit: 50,
			});
			if (messages.length === 0) {
				return "";
			}
			const botOpenId = this.tokenProvider?.getCachedBotOpenId();
			return this.formatThreadContext(messages, botOpenId);
		} catch (error) {
			this.logger.warn(
				`Failed to fetch Feishu thread context: ${error instanceof Error ? error.message : String(error)}`,
			);
			return "";
		}
	}

	async postReply(
		event: FeishuWebhookEvent,
		runner: IAgentRunner,
	): Promise<void> {
		try {
			const messages = runner.getMessages();
			const lastAssistantMessage = [...messages]
				.reverse()
				.find((m) => m.type === "assistant");

			let summary = "Task completed.";
			if (
				lastAssistantMessage &&
				lastAssistantMessage.type === "assistant" &&
				"message" in lastAssistantMessage
			) {
				const msg = lastAssistantMessage as {
					message: { content: Array<{ type: string; text?: string }> };
				};
				const textBlock = msg.message.content?.find(
					(block) => block.type === "text" && block.text,
				);
				if (textBlock?.text) {
					summary = textBlock.text;
				}
			}

			// Honor the no-response sentinel (substring, not exact — agents sometimes
			// narrate around it, and that deliberation must never reach the thread).
			if (summary.includes(FEISHU_NO_RESPONSE_SENTINEL)) {
				this.logger.info(
					`Feishu agent opted not to respond in chat ${event.payload.chatId} (no-response sentinel)`,
				);
				return;
			}

			const token = await this.getToken();
			if (!token) {
				this.logger.warn(
					"Cannot post Feishu reply: no tenant_access_token available",
				);
				return;
			}

			await new FeishuMessageService(this.apiBaseUrl).replyMessage({
				token,
				messageId: event.payload.messageId,
				text: summary,
				replyInThread: true,
			});

			this.logger.info(
				`Posted Feishu reply to chat ${event.payload.chatId} (message ${event.payload.messageId})`,
			);
		} catch (error) {
			this.logger.error(
				"Failed to post Feishu reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	async acknowledgeReceipt(event: FeishuWebhookEvent): Promise<void> {
		const token = await this.getToken();
		if (!token) {
			this.logger.warn(
				"Cannot add Feishu reaction: no tenant_access_token available",
			);
			return;
		}
		try {
			await new FeishuReactionService(this.apiBaseUrl).addReaction({
				token,
				messageId: event.payload.messageId,
				emojiType: RECEIPT_EMOJI,
			});
		} catch (error) {
			this.logger.warn(
				`Failed to add Feishu receipt reaction: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Add the "processed" reaction once the agent finished its turn. Runs whether
	 * or not a reply was posted, so users can tell a silently-skipped message was
	 * still handled.
	 *
	 * Unlike Slack, this does NOT remove the receipt reaction first: Feishu's
	 * remove-reaction API requires the receipt reaction_id, and retaining that id
	 * across the turn would leak (the id is never reclaimed when a runner errors
	 * before completing). Leaving both reactions ("OnIt" + "DONE") reads cleanly
	 * as "received, then done" and keeps the adapter stateless. Best-effort.
	 */
	async acknowledgeProcessed(event: FeishuWebhookEvent): Promise<void> {
		const token = await this.getToken();
		if (!token) {
			return;
		}
		try {
			await new FeishuReactionService(this.apiBaseUrl).addReaction({
				token,
				messageId: event.payload.messageId,
				emojiType: PROCESSED_EMOJI,
			});
		} catch (error) {
			this.logger.warn(
				`Failed to add Feishu processed reaction: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async notifyBusy(event: FeishuWebhookEvent): Promise<void> {
		const token = await this.getToken();
		if (!token) {
			return;
		}
		try {
			await new FeishuMessageService(this.apiBaseUrl).replyMessage({
				token,
				messageId: event.payload.messageId,
				text: "I'm still working on the previous request in this thread. I'll pick up your new message once I'm done.",
				replyInThread: true,
			});
		} catch (error) {
			this.logger.warn(
				`Failed to post Feishu busy notice: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private formatThreadContext(
		messages: FeishuThreadMessage[],
		botOpenId?: string,
	): string {
		const formattedMessages = messages
			.map((msg) => {
				const isSelf =
					(botOpenId && msg.senderId === botOpenId) || msg.senderType === "app";
				const author = isSelf ? "assistant (you)" : (msg.senderId ?? "unknown");
				return `  <message>
    <author>${author}</author>
    <timestamp>${msg.createTime ?? ""}</timestamp>
    <content>
${msg.text}
    </content>
  </message>`;
			})
			.join("\n");

		return `<feishu_thread_context>\n${formattedMessages}\n</feishu_thread_context>`;
	}
}
