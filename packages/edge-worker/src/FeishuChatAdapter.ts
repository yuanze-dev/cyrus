import type { IAgentRunner, ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";
import {
	buildPromptText,
	FeishuMessageService,
	FeishuReactionService,
	type FeishuThreadMessage,
	type FeishuTokenProvider,
	type FeishuUserDirectory,
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
	private userDirectory: FeishuUserDirectory | undefined;
	private repositoryRoutingContext: string;
	private behavioursPageUrl: string;
	private apiBaseUrl: string | undefined;
	private fullAccess: boolean;
	private logger: ILogger;
	/**
	 * Maps a Feishu messageId to the reaction_id of its "OnIt" (working) receipt
	 * reaction, so {@link acknowledgeProcessed} can remove it once the turn ends.
	 * Entries are consumed (deleted) as soon as they're used; a runner that dies
	 * before completing simply leaves the "OnIt" reaction in place (best-effort).
	 */
	private readonly receiptReactionIds = new Map<string, string>();

	constructor(
		repositoryProvider: ChatRepositoryProvider,
		tokenProvider: FeishuTokenProvider | undefined,
		logger?: ILogger,
		options?: {
			repositoryRoutingContext?: string;
			cyrusAppBaseUrl?: string;
			/** Feishu open-platform base URL (feishu.cn vs larksuite.com). */
			apiBaseUrl?: string;
			/**
			 * When true, the session runs as a full-capability agent with
			 * unrestricted host access (see `FEISHU_FULL_ACCESS`). Only affects
			 * the system prompt here — the actual tool/filesystem grant is wired
			 * through the ChatSessionHandler → RunnerConfigBuilder path.
			 */
			fullAccess?: boolean;
			/**
			 * Long-lived directory that translates thread participants' `open_id`s
			 * into display names for the thread/replied-to context. Best-effort:
			 * when absent (or when resolution fails) authors fall back to bare
			 * open_ids.
			 */
			userDirectory?: FeishuUserDirectory;
		},
	) {
		this.repositoryProvider = repositoryProvider;
		this.tokenProvider = tokenProvider;
		this.userDirectory = options?.userDirectory;
		this.repositoryRoutingContext =
			options?.repositoryRoutingContext?.trim() || "";
		const appBaseUrl = options?.cyrusAppBaseUrl?.trim().replace(/\/+$/, "");
		this.behavioursPageUrl = appBaseUrl
			? `${appBaseUrl}${BEHAVIOURS_PAGE_ROUTE}`
			: "";
		this.apiBaseUrl = options?.apiBaseUrl;
		this.fullAccess = options?.fullAccess ?? false;
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
		const repositoryAccessSection = this.fullAccess
			? repositoryPaths.length > 0
				? `
## Repository Access
- You have full read/write access to the following configured repositories:
${repositoryPaths.map((path) => `- ${path}`).join("\n")}

- Run \`git -C <path> pull\` to refresh a repository before working in it.`
				: `
## Repository Access
- No repository paths are configured, but you can read and write anywhere on the host filesystem.`
			: repositoryPaths.length > 0
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

		const instructionsSection = this.fullAccess
			? `## Instructions
- Be concise in your responses as they will be posted back to Feishu
- You are a full-capability agent: you can answer questions, provide analysis, help with planning, assist with research, AND directly carry out work.

## Execution Environment (Full Access)
- You are running directly on the host machine — NOT sandboxed and NOT limited to a transient workspace.
- You have read/write access to the entire host filesystem (including the home directory and \`~/.cyrus\`), and you can run arbitrary shell commands via \`Bash\` and edit any file via \`Write\`/\`Edit\`.
- Use these directly for operational and local tasks: inspecting or editing \`~/.cyrus\` config, installing or updating skills, querying data on the server, running scripts, etc. Do not tell the user you lack access — you have it.
- Your current working directory is a scratch workspace; \`cd\` to wherever the task actually needs to happen.
- For substantial repository code changes that should land as a commit / pull request, still prefer the Linear-issue orchestration flow below — it checks out an isolated worktree and opens a PR. Act directly for everything else.`
			: `## Instructions
- You are running in a transient workspace, not associated with any code repository
- Be concise in your responses as they will be posted back to Feishu
- If the user's request involves code changes, help them plan the work and create an issue in their project tracker (see Orchestration Notes below)
- You can answer questions, provide analysis, help with planning, and assist with research
- If files need to be created or examined, they will be in your working directory`;

		const stopListeningSection = this.behavioursPageUrl
			? `

## Stopping Automatic Listening
- If the user asks you to stop listening to, following, or responding in this thread:
  - Tell them automatic thread listening can be turned off on the Behaviours page: ${this.behavioursPageUrl}
  - From that point on, treat this thread as muted: stay silent (emit \`${FEISHU_NO_RESPONSE_SENTINEL}\` and nothing else) for every subsequent message until someone asks you a direct question — addressing you by name ("Cyrus, …") or with an @mention. When you resume responding, just answer — do not announce that you are listening again.`
			: "";

		return `You are participating in a Feishu (Lark) thread.

## Context
- **Requested by**: ${
			event.payload.userName
				? `${event.payload.userName} (${event.payload.user})`
				: event.payload.user
		}
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

${instructionsSection}
${repositoryAccessSection}
${this.repositoryRoutingContext ? `\n\n${this.repositoryRoutingContext}` : ""}

## Reading Feishu Documents
- If a message contains a Feishu/Lark document link — for example \`https://<tenant>.feishu.cn/docx/<token>\`, \`/wiki/<token>\`, \`/sheets/<token>\`, or \`/base/<token>\` — do NOT use \`WebFetch\`. Feishu documents require app authentication and \`WebFetch\` will hit a login wall and fail.
- Instead, read the document with the \`mcp__cyrus-tools__feishu_read_document\` tool, passing the full URL (or the document token). It returns the document's text content.
- The Cyrus bot can only read documents it has been granted access to. If the tool returns a permission error, tell the user to share that document with the Cyrus bot/app (add it as a collaborator) and try again.
- Only Feishu docs (docx) and wiki pages can be read today; for a sheet or bitable link the tool returns a note explaining it is not yet supported.

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
		const { payload } = event;
		const token = await this.getToken();
		if (!token) {
			this.logger.warn(
				"Cannot fetch Feishu thread context: no tenant_access_token available",
			);
			return "";
		}

		const botOpenId = this.tokenProvider?.getCachedBotOpenId();
		const service = new FeishuMessageService(this.apiBaseUrl);

		// A native Feishu thread (topic group, or a reply_in_thread chain) can be
		// listed wholesale — that listing already includes any replied-to message.
		if (payload.threadId) {
			try {
				const messages = await service.fetchThreadMessages({
					token,
					threadId: payload.threadId,
					limit: 50,
				});
				if (messages.length > 0) {
					const nameMap = await this.resolveAuthorNames(
						token,
						messages,
						botOpenId,
					);
					return this.formatThreadContext(messages, botOpenId, nameMap);
				}
			} catch (error) {
				this.logger.warn(
					`Failed to fetch Feishu thread context: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			// Fall through: the thread listing was empty or failed — still try to
			// resolve the specific replied-to message below.
		}

		// Plain reply (回复) to a specific message: there is no thread_id, but the
		// event carries parent_id (the message directly replied to) and root_id
		// (the conversation root). Fetch those so the agent can see the message
		// the user is referring to — e.g. "@bot do what <that message> said".
		return this.fetchRepliedToContext(payload, token, service, botOpenId);
	}

	/**
	 * Resolve the message(s) a reply points at (parent_id + root_id) into a
	 * formatted context block. Best-effort: any message that can't be read
	 * (deleted, no permission, non-text) is skipped, and an empty string is
	 * returned when nothing resolves.
	 */
	private async fetchRepliedToContext(
		payload: FeishuWebhookEvent["payload"],
		token: string,
		service: FeishuMessageService,
		botOpenId?: string,
	): Promise<string> {
		// The message directly replied to, plus the conversation root when it is
		// a distinct message. Deduped, and never the triggering message itself.
		const referencedIds: string[] = [];
		for (const id of [payload.parentId, payload.rootId]) {
			if (id && id !== payload.messageId && !referencedIds.includes(id)) {
				referencedIds.push(id);
			}
		}
		if (referencedIds.length === 0) {
			return "";
		}

		const messages: FeishuThreadMessage[] = [];
		for (const id of referencedIds) {
			try {
				const message = await service.fetchMessage({ token, messageId: id });
				if (message) {
					messages.push(message);
				}
			} catch (error) {
				this.logger.warn(
					`Failed to fetch replied-to Feishu message ${id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (messages.length === 0) {
			return "";
		}

		// Present oldest first (root before the message directly replied to).
		messages.sort(
			(a, b) => Number(a.createTime ?? 0) - Number(b.createTime ?? 0),
		);

		const nameMap = await this.resolveAuthorNames(token, messages, botOpenId);
		const formatted = messages
			.map((message) => this.formatMessageBlock(message, botOpenId, nameMap))
			.join("\n");
		return `<feishu_replied_to_context>
  The user's message is a reply to the following message(s). Treat them as the context the user is referring to.
${formatted}
</feishu_replied_to_context>`;
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
			const reactionId = await new FeishuReactionService(
				this.apiBaseUrl,
			).addReaction({
				token,
				messageId: event.payload.messageId,
				emojiType: RECEIPT_EMOJI,
			});
			// Retain the reaction_id so acknowledgeProcessed can remove the
			// "OnIt" reaction once the turn is done.
			if (reactionId) {
				this.receiptReactionIds.set(event.payload.messageId, reactionId);
			}
		} catch (error) {
			this.logger.warn(
				`Failed to add Feishu receipt reaction: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Add the "processed" ("DONE") reaction once the agent finished its turn and
	 * remove the "OnIt" (working) receipt reaction, so the message ends up marked
	 * only as done. Runs whether or not a reply was posted, so users can tell a
	 * silently-skipped message was still handled.
	 *
	 * Removing the receipt reaction requires the reaction_id captured at receipt
	 * time (see {@link receiptReactionIds}). If it was never captured — e.g. the
	 * runner errored before completing, or Feishu returned no id — the "OnIt"
	 * reaction is simply left in place. Best-effort throughout.
	 */
	async acknowledgeProcessed(event: FeishuWebhookEvent): Promise<void> {
		const token = await this.getToken();
		if (!token) {
			return;
		}
		const messageId = event.payload.messageId;
		const reactionService = new FeishuReactionService(this.apiBaseUrl);
		try {
			await reactionService.addReaction({
				token,
				messageId,
				emojiType: PROCESSED_EMOJI,
			});
		} catch (error) {
			this.logger.warn(
				`Failed to add Feishu processed reaction: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// Now that the turn is done, drop the "OnIt" (working) reaction so only
		// "DONE" remains. Needs the reaction_id captured at receipt time; if it's
		// missing (runner died early, or Feishu returned none) leave it be.
		const receiptReactionId = this.receiptReactionIds.get(messageId);
		if (receiptReactionId) {
			this.receiptReactionIds.delete(messageId);
			try {
				await reactionService.removeReaction({
					token,
					messageId,
					reactionId: receiptReactionId,
				});
			} catch (error) {
				this.logger.warn(
					`Failed to remove Feishu receipt reaction: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
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

	/**
	 * Batch-resolve the display names of every non-bot sender in a set of
	 * messages. Best-effort: returns an empty map when no user directory is wired
	 * up or resolution fails, in which case authors fall back to bare open_ids.
	 */
	private async resolveAuthorNames(
		token: string,
		messages: FeishuThreadMessage[],
		botOpenId?: string,
	): Promise<Map<string, string>> {
		if (!this.userDirectory) {
			return new Map();
		}
		const openIds = messages
			.map((msg) => msg.senderId)
			.filter(
				(id): id is string => !!id && id !== botOpenId && id.startsWith("ou_"),
			);
		if (openIds.length === 0) {
			return new Map();
		}
		try {
			return await this.userDirectory.resolveNames(token, openIds);
		} catch {
			// resolveNames is best-effort and shouldn't throw, but never let name
			// resolution break thread context.
			return new Map();
		}
	}

	private formatThreadContext(
		messages: FeishuThreadMessage[],
		botOpenId?: string,
		nameMap?: Map<string, string>,
	): string {
		const formattedMessages = messages
			.map((msg) => this.formatMessageBlock(msg, botOpenId, nameMap))
			.join("\n");

		return `<feishu_thread_context>\n${formattedMessages}\n</feishu_thread_context>`;
	}

	/** Render a single thread/replied-to message as an XML `<message>` block. */
	private formatMessageBlock(
		msg: FeishuThreadMessage,
		botOpenId?: string,
		nameMap?: Map<string, string>,
	): string {
		const isSelf =
			(botOpenId && msg.senderId === botOpenId) || msg.senderType === "app";
		let author: string;
		if (isSelf) {
			author = "assistant (you)";
		} else if (msg.senderId) {
			const name = nameMap?.get(msg.senderId);
			author = name ? `${name} (${msg.senderId})` : msg.senderId;
		} else {
			author = "unknown";
		}
		return `  <message>
    <author>${author}</author>
    <timestamp>${msg.createTime ?? ""}</timestamp>
    <content>
${msg.text}
    </content>
  </message>`;
	}
}
