import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ChannelBinding,
	IAgentRunner,
	ILogger,
	RunnerType,
} from "cyrus-core";
import { createLogger } from "cyrus-core";
import {
	buildPromptText,
	containsMarkdown,
	extractFeishuImageKeys,
	FeishuMessageService,
	FeishuReactionService,
	type FeishuThreadMessage,
	type FeishuTokenProvider,
	type FeishuUserDirectory,
	type FeishuWebhookEvent,
	feishuThreadRoot,
	feishuThreadRootCandidates,
} from "cyrus-feishu-event-transport";
import { fileTypeFromBuffer } from "file-type";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import {
	type ChatPlatformAdapter,
	type ChatRoutingContext,
	type ChatTaskInstructions,
	sanitizeThreadKeyForPath,
} from "./ChatSessionHandler.js";
import type { FeishuIssueBindingInput } from "./FeishuIssueNotificationService.js";
import { stripFeishuRunnerPrefix } from "./FeishuRunnerRouting.js";

/** Full tool name the Feishu agent uses to create Linear issues. */
const LINEAR_SAVE_ISSUE_TOOL = "mcp__linear__save_issue";

/**
 * Matches a Linear issue URL and captures the issue identifier (e.g. "IN-42").
 * Used to recover the created issue's identifier/URL from a `save_issue` result.
 */
const LINEAR_ISSUE_URL_RE =
	/https?:\/\/linear\.app\/[^\s"')]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^\s"')]*)?/i;

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

/**
 * How long a chat's last agent turn stays eligible to be injected as fallback
 * context into a *new* session in the same chat. Bounds the "answer landed in a
 * brand-new session" recovery (see {@link FeishuChatAdapter.recentChatTurns}) so
 * a stale, unrelated turn from hours ago is never dredged up.
 */
export const RECENT_CHAT_CONTEXT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Cap on how many images from a single Feishu message are downloaded and handed
 * to the model, bounding both API calls and prompt bloat. Mirrors the Linear
 * attachment limit.
 */
export const MAX_FEISHU_IMAGES_PER_MESSAGE = 20;

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
	/**
	 * Cyrus home directory. Root under which per-thread image attachments are
	 * stored (`<cyrusHome>/feishu-attachments/<thread>/`). When unset, images in
	 * a message can't be downloaded and the session degrades to text only.
	 */
	private cyrusHome: string | undefined;
	private onIssueCreated:
		| ((binding: FeishuIssueBindingInput) => void)
		| undefined;
	private logger: ILogger;
	/**
	 * Maps a Feishu messageId to the reaction_id of its "OnIt" (working) receipt
	 * reaction, so {@link acknowledgeProcessed} can remove it once the turn ends.
	 * Entries are consumed (deleted) as soon as they're used; a runner that dies
	 * before completing simply leaves the "OnIt" reaction in place (best-effort).
	 */
	private readonly receiptReactionIds = new Map<string, string>();
	/**
	 * Per-chat memory of the agent's most recent turn (its reply text + which
	 * thread it belonged to). When a fresh session is created in a chat where the
	 * agent was just active in a *different* thread — the "追问另起新会话" failure
	 * mode where a user's answer lands in a brand-new, zero-history session — this
	 * lets {@link fetchThreadContext} inject that recent reply so the agent still
	 * sees the question it just asked, instead of claiming it has no context.
	 * Best-effort and time-bounded ({@link RECENT_CHAT_CONTEXT_WINDOW_MS}).
	 */
	private readonly recentChatTurns = new Map<
		string,
		{ threadKey: string; reply: string; at: number }
	>();

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
			 * Cyrus home directory, used to derive the per-thread directory where
			 * images attached to a Feishu message are downloaded so the session can
			 * read them. Omit to disable image download (text-only).
			 */
			cyrusHome?: string;
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
			/**
			 * Invoked (best-effort) once per turn for each Linear issue the agent
			 * created via `mcp__linear__save_issue`, carrying the source thread
			 * context. Lets the owner persist a Feishu→Linear binding so the thread
			 * can be notified when that issue is later completed.
			 */
			onIssueCreated?: (binding: FeishuIssueBindingInput) => void;
		},
	) {
		this.repositoryProvider = repositoryProvider;
		this.tokenProvider = tokenProvider;
		this.userDirectory = options?.userDirectory;
		this.onIssueCreated = options?.onIssueCreated;
		this.repositoryRoutingContext =
			options?.repositoryRoutingContext?.trim() || "";
		const appBaseUrl = options?.cyrusAppBaseUrl?.trim().replace(/\/+$/, "");
		this.behavioursPageUrl = appBaseUrl
			? `${appBaseUrl}${BEHAVIOURS_PAGE_ROUTE}`
			: "";
		this.apiBaseUrl = options?.apiBaseUrl;
		this.cyrusHome = options?.cyrusHome;
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

	async extractTaskInstructions(
		event: FeishuWebhookEvent,
	): Promise<ChatTaskInstructions> {
		// Drop the bot's OWN @mention (the `@Cyrus` a user must prepend to address
		// the bot in a group) before parsing the runner prefix — otherwise a group
		// message like "@Cyrus /codex …" leaves `/codex` off the start of the text
		// and the prefix silently fails to route (IN-39). Matched by open_id, so a
		// bot display name with spaces / CJK is handled robustly.
		const botOpenId = this.tokenProvider?.getCachedBotOpenId();
		const text = buildPromptText(event.payload, botOpenId);
		const prefixResult = stripFeishuRunnerPrefix(text);
		// Download any images the message carries and describe them so the model
		// can view them with the Read tool. Best-effort: image failures never block
		// the text prompt.
		const imageSection = await this.buildImageSection(event);
		const strippedText = prefixResult.text;

		if (imageSection) {
			return {
				text: strippedText
					? `${strippedText}\n\n${imageSection}`
					: imageSection,
				requestedRunnerType: prefixResult.runnerType,
			};
		}
		return {
			text: strippedText || "Ask the user for more context",
			requestedRunnerType: prefixResult.runnerType,
		};
	}

	/**
	 * Download every image attached to a Feishu message (a standalone `image`
	 * message, or images embedded in a `post`) into a per-thread directory the
	 * session can read, and return a manifest referencing their local paths.
	 *
	 * Best-effort throughout — returns "":
	 *  - when the message carries no images, or
	 *  - when no `cyrusHome` is configured (image download disabled).
	 * When images exist but downloading them fails (no token, missing
	 * `im:resource` permission, network error), returns a short human-readable
	 * note instead of the manifest so the model can tell the user their image
	 * couldn't be read rather than silently ignoring it.
	 */
	private async buildImageSection(event: FeishuWebhookEvent): Promise<string> {
		const imageKeys = extractFeishuImageKeys(event.payload);
		if (imageKeys.length === 0) {
			return "";
		}
		if (!this.cyrusHome) {
			this.logger.warn(
				"Feishu message contains image(s) but no cyrusHome is configured; skipping image download",
			);
			return this.formatImageFailureNote(imageKeys.length);
		}

		const token = await this.getToken();
		if (!token) {
			this.logger.warn(
				"Cannot download Feishu image(s): no tenant_access_token available",
			);
			return this.formatImageFailureNote(imageKeys.length);
		}

		const limitedKeys = imageKeys.slice(0, MAX_FEISHU_IMAGES_PER_MESSAGE);
		const skipped = imageKeys.length - limitedKeys.length;
		if (skipped > 0) {
			this.logger.warn(
				`Feishu message carried ${imageKeys.length} images; downloading only the first ${MAX_FEISHU_IMAGES_PER_MESSAGE}`,
			);
		}

		const threadKey = this.getThreadKey(event);
		const dir = join(
			this.cyrusHome,
			"feishu-attachments",
			sanitizeThreadKeyForPath(threadKey),
		);
		const service = new FeishuMessageService(this.apiBaseUrl);

		const localPaths: string[] = [];
		let failed = 0;
		try {
			await mkdir(dir, { recursive: true });
		} catch (error) {
			this.logger.warn(
				`Failed to create Feishu attachments dir ${dir}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return this.formatImageFailureNote(imageKeys.length);
		}

		for (const [index, imageKey] of limitedKeys.entries()) {
			try {
				const { buffer, contentType } = await service.downloadMessageResource({
					token,
					messageId: event.payload.messageId,
					fileKey: imageKey,
				});
				const ext = await resolveImageExtension(buffer, contentType);
				// Name by messageId + index so repeated downloads of the same message
				// are idempotent and images from different messages never collide.
				const filename = `${sanitizeThreadKeyForPath(event.payload.messageId)}_${index + 1}${ext}`;
				const filePath = join(dir, filename);
				await writeFile(filePath, buffer);
				localPaths.push(filePath);
			} catch (error) {
				failed++;
				this.logger.warn(
					`Failed to download Feishu image ${imageKey} (message ${event.payload.messageId}): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		if (localPaths.length === 0) {
			return this.formatImageFailureNote(imageKeys.length);
		}
		return this.formatImageManifest(localPaths, failed, skipped);
	}

	/** Manifest listing successfully-downloaded images for the model to Read. */
	private formatImageManifest(
		localPaths: string[],
		failed: number,
		skipped: number,
	): string {
		const lines = [
			"<feishu_attached_images>",
			`  The user's Feishu message included ${localPaths.length} image${
				localPaths.length > 1 ? "s" : ""
			}, downloaded locally. Use the Read tool on each path to view the image and factor it into your response:`,
		];
		localPaths.forEach((path, index) => {
			lines.push(`  ${index + 1}. ${path}`);
		});
		if (failed > 0) {
			lines.push(
				`  Note: ${failed} additional image${failed > 1 ? "s" : ""} failed to download and could not be included.`,
			);
		}
		if (skipped > 0) {
			lines.push(
				`  Note: ${skipped} further image${skipped > 1 ? "s were" : " was"} skipped (per-message image limit).`,
			);
		}
		lines.push("</feishu_attached_images>");
		return lines.join("\n");
	}

	/** Note shown when images were present but none could be downloaded. */
	private formatImageFailureNote(count: number): string {
		return `<feishu_attached_images>
  The user's Feishu message included ${count} image${count > 1 ? "s" : ""}, but ${
		count > 1 ? "they" : "it"
	} could not be downloaded (the Cyrus app may be missing message-image read permission). Let the user know you could not view the image${
		count > 1 ? "s" : ""
	} and, if relevant, ask them to describe ${count > 1 ? "them" : "it"} or re-share.
</feishu_attached_images>`;
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

	getRoutingContext(event: FeishuWebhookEvent): ChatRoutingContext {
		return {
			userId: event.payload.user,
			chatId: event.payload.chatId,
		};
	}

	/**
	 * Every thread key this event could belong to — `chatId:threadId`,
	 * `chatId:rootId`, `chatId:messageId` — most stable first. The head equals
	 * {@link getThreadKey}; the rest let ChatSessionHandler reconcile a
	 * conversation whose canonical key shifts across turns (a plain @mention
	 * keyed on `messageId`, then in-topic follow-ups keyed on `thread_id`) back
	 * to the one session, instead of spawning a second, zero-history one.
	 */
	getThreadAliasKeys(event: FeishuWebhookEvent): string[] {
		const { chatId } = event.payload;
		return feishuThreadRootCandidates(event.payload).map(
			(candidate) => `${chatId}:${candidate}`,
		);
	}

	getEventId(event: FeishuWebhookEvent): string {
		return event.eventId;
	}

	/**
	 * Channel identity recorded on a new session (IN-42 §Q1). `threadRoot` is the
	 * canonical thread key component and doubles as the message id to reply into
	 * the thread; `openId` is the requesting user.
	 */
	getChannelBinding(event: FeishuWebhookEvent): ChannelBinding {
		const threadRoot = feishuThreadRoot(event.payload);
		return {
			kind: "feishu",
			chatId: event.payload.chatId,
			threadRoot,
			rootMessageId: threadRoot,
			openId: event.payload.user,
		};
	}

	/**
	 * Human-readable label for the requesting Feishu user, used when tracing a
	 * cross-channel injection into another channel's timeline (IN-42 §5 P3), e.g.
	 * "来自飞书 张三 (ou_xxx) 的追问". Prefers the webhook-carried display name,
	 * then a directory lookup, and always falls back to the bare open_id so a
	 * label is never empty.
	 */
	async getAuthorLabel(event: FeishuWebhookEvent): Promise<string> {
		const openId = event.payload.user;
		if (event.payload.userName) {
			return `${event.payload.userName} (${openId})`;
		}
		if (openId && this.userDirectory) {
			try {
				const token = await this.getToken();
				if (token) {
					const names = await this.userDirectory.resolveNames(token, [openId]);
					const resolved = names.get(openId);
					if (resolved) {
						return `${resolved} (${openId})`;
					}
				}
			} catch {
				// Best-effort — fall through to the bare open_id.
			}
		}
		return openId ?? "unknown";
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

## Feishu Message Formatting
Your response is posted as a Feishu (Lark) interactive card that renders a **subset** of Markdown, so you may use Markdown formatting freely.

Supported (use these — they render):
- **bold**, *italic*, ~~strikethrough~~
- Ordered and unordered lists ("- item" / "1. item" on their own lines)
- \`inline code\` and fenced \`\`\` code blocks
- [text](url) links, and bare URLs (they auto-link)
- Block quotes ("> quote") and horizontal rules ("---")
- Emoji

Avoid (not supported / render poorly in Feishu cards):
- Tables (no | --- | syntax — use plain lines or lists instead)
- Markdown headers (# has limited/no rendering — use **bold** or an ALL CAPS line ending with a colon instead)`;
	}

	async fetchThreadContext(event: FeishuWebhookEvent): Promise<string> {
		// Prefer the real thread / replied-to linkage. Only when that yields
		// nothing — the conversation split into a brand-new session with no thread
		// or reply linkage — fall back to the chat's most recent agent turn so the
		// agent still sees the question it just asked (AC: no "this is a new
		// session, I lost your context" replies).
		const linked = await this.fetchLinkedThreadContext(event);
		if (linked) {
			return linked;
		}
		return this.fetchRecentChatFallbackContext(event);
	}

	private async fetchLinkedThreadContext(
		event: FeishuWebhookEvent,
	): Promise<string> {
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

	/**
	 * Fallback context for a new session: the agent's most recent reply in this
	 * SAME chat but a DIFFERENT thread, within {@link RECENT_CHAT_CONTEXT_WINDOW_MS}.
	 * Recovers the "追问另起新会话" failure mode — a user's answer landing in a
	 * fresh, zero-history session — by handing the agent back the message it just
	 * posted (typically the very question being answered). Returns "" when there
	 * is no eligible recent turn.
	 */
	private fetchRecentChatFallbackContext(event: FeishuWebhookEvent): string {
		const { chatId } = event.payload;
		const recent = this.recentChatTurns.get(chatId);
		if (!recent) {
			return "";
		}
		// Same thread ⇒ the linked-context path already covers it (or it was
		// deliberately empty); only bridge across a split into a new thread.
		if (recent.threadKey === this.getThreadKey(event)) {
			return "";
		}
		if (Date.now() - recent.at > RECENT_CHAT_CONTEXT_WINDOW_MS) {
			this.recentChatTurns.delete(chatId);
			return "";
		}
		return `<feishu_recent_chat_context>
  A new conversation was started, but you were just active in this same chat moments ago (in a different thread). Your most recent message there was:
  <your_last_message>
${recent.reply}
  </your_last_message>
  The user may be replying to it — for example answering a question you just asked. Treat it as context and do NOT claim you have lost the previous conversation.
</feishu_recent_chat_context>`;
	}

	/**
	 * Remember the agent's reply as this chat's most recent turn, so a later
	 * session that splits off into a new thread can recover it via
	 * {@link fetchRecentChatFallbackContext}. Best-effort — no-op for empty text.
	 */
	private recordChatTurn(event: FeishuWebhookEvent, reply: string): void {
		if (!reply) {
			return;
		}
		this.recentChatTurns.set(event.payload.chatId, {
			threadKey: this.getThreadKey(event),
			reply,
			at: Date.now(),
		});
	}

	async postReply(
		event: FeishuWebhookEvent,
		runner: IAgentRunner,
	): Promise<void> {
		try {
			const messages = runner.getMessages();

			// Capture any Linear issues the agent created this turn so the thread
			// can be notified on completion. Runs regardless of whether we end up
			// replying (e.g. the no-response sentinel below), and never breaks the
			// reply path — capture failures are logged, not thrown.
			this.captureCreatedIssues(event, messages);

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

			// Remember this turn so a later session that splits into a new thread in
			// the same chat can recover it as fallback context.
			this.recordChatTurn(event, summary);

			const token = await this.getToken();
			if (!token) {
				this.logger.warn(
					"Cannot post Feishu reply: no tenant_access_token available",
				);
				return;
			}

			const service = new FeishuMessageService(this.apiBaseUrl);

			// Only wrap the reply in an interactive card when it actually contains
			// Markdown syntax Feishu needs a card to render. Plain text (e.g. a bare
			// "你好") goes out as an ordinary `msg_type: "text"` bubble instead of a
			// card.
			if (!containsMarkdown(summary)) {
				await service.replyMessage({
					token,
					messageId: event.payload.messageId,
					text: summary,
					replyInThread: true,
					format: "text",
				});
				this.logger.info(
					`Posted Feishu plain-text reply to chat ${event.payload.chatId} (message ${event.payload.messageId})`,
				);
				return;
			}

			// Post the agent's Markdown summary as an interactive card so Feishu
			// renders it (bold, lists, links, code, ...). If the card send fails
			// (Feishu code!=0 or network error), fall back to a plain-text reply so
			// the user still gets an answer — degraded to Markdown source, but never
			// silent.
			try {
				await service.replyMessage({
					token,
					messageId: event.payload.messageId,
					text: summary,
					replyInThread: true,
					format: "markdown",
				});
				this.logger.info(
					`Posted Feishu Markdown card reply to chat ${event.payload.chatId} (message ${event.payload.messageId})`,
				);
			} catch (cardError) {
				this.logger.warn(
					`Feishu Markdown card reply failed, falling back to plain text: ${
						cardError instanceof Error ? cardError.message : String(cardError)
					}`,
				);
				await service.replyMessage({
					token,
					messageId: event.payload.messageId,
					text: summary,
					replyInThread: true,
				});
				this.logger.info(
					`Posted Feishu plain-text fallback reply to chat ${event.payload.chatId} (message ${event.payload.messageId})`,
				);
			}
		} catch (error) {
			this.logger.error(
				"Failed to post Feishu reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/**
	 * Inspect this turn's messages for `mcp__linear__save_issue` calls and, for
	 * each successfully-created issue, hand a Feishu→Linear binding to the
	 * configured {@link onIssueCreated} callback. Best-effort: no callback, no
	 * created issue, or a parse miss simply records nothing.
	 */
	private captureCreatedIssues(
		event: FeishuWebhookEvent,
		messages: ReturnType<IAgentRunner["getMessages"]>,
	): void {
		if (!this.onIssueCreated) {
			return;
		}
		try {
			const created = extractCreatedLinearIssues(messages);
			if (created.length === 0) {
				return;
			}
			const rootMessageId = feishuThreadRoot(event.payload);
			for (const issue of created) {
				this.onIssueCreated({
					issueIdentifier: issue.issueIdentifier,
					issueId: issue.issueId,
					issueTitle: issue.issueTitle,
					issueUrl: issue.issueUrl,
					chatId: event.payload.chatId,
					openId: event.payload.user,
					userName: event.payload.userName,
					rootMessageId,
				});
			}
		} catch (error) {
			this.logger.warn(
				`Failed to capture created Linear issue from Feishu session: ${error instanceof Error ? error.message : String(error)}`,
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
	 * Notify the thread that a cross-channel follow-up was NOT applied because the
	 * requester is not authorized to steer the bound session (IN-42 §5 P3 红线).
	 * Kept deliberately vague about the target session so it doesn't disclose
	 * details of a task the user may not own.
	 */
	async notifyCrossChannelBlocked(
		event: FeishuWebhookEvent,
		_threadKey: string,
	): Promise<void> {
		const token = await this.getToken();
		if (!token) {
			return;
		}
		try {
			await new FeishuMessageService(this.apiBaseUrl).replyMessage({
				token,
				messageId: event.payload.messageId,
				text: "抱歉，你没有权限向这个任务追加消息（该任务由其他会话发起）。",
				replyInThread: true,
			});
		} catch (error) {
			this.logger.warn(
				`Failed to post Feishu cross-channel block notice: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async notifyRunnerLocked(
		event: FeishuWebhookEvent,
		runnerType: RunnerType,
	): Promise<void> {
		const token = await this.getToken();
		if (!token) {
			return;
		}
		try {
			await new FeishuMessageService(this.apiBaseUrl).replyMessage({
				token,
				messageId: event.payload.messageId,
				text: `本话题已锁定 ${runnerType} 引擎，请新开话题再切换引擎。`,
				replyInThread: true,
			});
		} catch (error) {
			this.logger.warn(
				`Failed to post Feishu runner-lock notice: ${error instanceof Error ? error.message : String(error)}`,
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

/**
 * Resolve a file extension (with leading dot) for a downloaded Feishu image,
 * sniffing the magic bytes first and falling back to the reported content type,
 * then to `.png`. Keeps the on-disk filename meaningful so the Read tool detects
 * the image type correctly.
 */
async function resolveImageExtension(
	buffer: Buffer,
	contentType?: string,
): Promise<string> {
	try {
		const detected = await fileTypeFromBuffer(buffer);
		if (detected?.ext) {
			return `.${detected.ext}`;
		}
	} catch {
		// Fall through to content-type / default.
	}
	const subtype = contentType?.split(";")[0]?.trim().split("/")[1];
	if (subtype) {
		// "jpeg" is the canonical subtype; keep the conventional ".jpg" extension.
		return subtype === "jpeg" ? ".jpg" : `.${subtype}`;
	}
	return ".png";
}

/** A Linear issue recovered from a `mcp__linear__save_issue` tool result. */
export interface CapturedLinearIssue {
	/** Linear issue identifier, e.g. "IN-42". */
	issueIdentifier: string;
	/** Linear issue UUID, when present in the result. */
	issueId?: string;
	/** Issue title (from the tool input, or the result when present). */
	issueTitle?: string;
	/** Linear issue URL, when present in the result. */
	issueUrl?: string;
}

/** Flatten a tool_result `content` (string or content-block array) to text. */
function toolResultText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((block) =>
				block &&
				typeof block === "object" &&
				(block as { type?: string }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
					? (block as { text: string }).text
					: "",
			)
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/**
 * Parse a `save_issue` tool result into the created issue's identifying fields.
 *
 * The official Linear MCP returns the issue's URL (and often a JSON body); this
 * recovers the identifier/URL/UUID robustly from either JSON or plain text.
 * Returns undefined when no issue identifier can be recovered.
 */
function parseIssueFromResult(text: string): CapturedLinearIssue | undefined {
	let identifier: string | undefined;
	let id: string | undefined;
	let url: string | undefined;
	let title: string | undefined;

	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const json = JSON.parse(trimmed) as unknown;
			const root = Array.isArray(json) ? json[0] : json;
			const obj = root as { issue?: unknown } & Record<string, unknown>;
			const issue = (obj?.issue ?? obj) as Record<string, unknown> | undefined;
			if (issue && typeof issue === "object") {
				if (typeof issue.identifier === "string") identifier = issue.identifier;
				if (typeof issue.id === "string") id = issue.id;
				if (typeof issue.url === "string") url = issue.url;
				if (typeof issue.title === "string") title = issue.title;
			}
		} catch {
			// Not JSON — fall through to regex extraction.
		}
	}

	const urlMatch = text.match(LINEAR_ISSUE_URL_RE);
	if (urlMatch) {
		if (!url) url = urlMatch[0];
		if (!identifier) identifier = urlMatch[1];
	}

	if (!identifier) {
		const idMatch = text.match(/\b([A-Z][A-Z0-9]*-\d+)\b/);
		if (idMatch) identifier = idMatch[1];
	}

	if (!id) {
		const uuidMatch = text.match(
			/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
		);
		if (uuidMatch) id = uuidMatch[0];
	}

	if (!identifier) {
		return undefined;
	}
	return {
		issueIdentifier: identifier,
		issueId: id,
		issueUrl: url,
		issueTitle: title,
	};
}

/**
 * Extract the Linear issues created via `mcp__linear__save_issue` in a run's
 * message stream. Correlates each successful (non-error) tool result with its
 * originating tool call to recover the created issue, deduping by identifier.
 *
 * Exported for unit testing. Tolerates loosely-typed SDK message shapes.
 */
export function extractCreatedLinearIssues(
	messages: ReturnType<IAgentRunner["getMessages"]>,
): CapturedLinearIssue[] {
	// tool_use_id → title from the save_issue call input (best-effort fallback).
	const saveIssueCalls = new Map<string, { title?: string }>();
	for (const message of messages) {
		const msg = message as {
			type?: string;
			message?: { content?: unknown };
		};
		if (msg.type !== "assistant" || !Array.isArray(msg.message?.content)) {
			continue;
		}
		for (const block of msg.message.content as Array<Record<string, unknown>>) {
			if (
				block?.type === "tool_use" &&
				block.name === LINEAR_SAVE_ISSUE_TOOL &&
				typeof block.id === "string"
			) {
				const input = block.input as { title?: unknown } | undefined;
				saveIssueCalls.set(block.id, {
					title: typeof input?.title === "string" ? input.title : undefined,
				});
			}
		}
	}
	if (saveIssueCalls.size === 0) {
		return [];
	}

	const results: CapturedLinearIssue[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		const msg = message as {
			type?: string;
			message?: { content?: unknown };
		};
		if (msg.type !== "user" || !Array.isArray(msg.message?.content)) {
			continue;
		}
		for (const block of msg.message.content as Array<Record<string, unknown>>) {
			if (block?.type !== "tool_result") {
				continue;
			}
			const toolUseId = block.tool_use_id;
			if (typeof toolUseId !== "string") {
				continue;
			}
			const call = saveIssueCalls.get(toolUseId);
			if (!call || block.is_error === true) {
				continue;
			}
			const parsed = parseIssueFromResult(toolResultText(block.content));
			if (!parsed || seen.has(parsed.issueIdentifier)) {
				continue;
			}
			seen.add(parsed.issueIdentifier);
			results.push({
				...parsed,
				issueTitle: parsed.issueTitle ?? call.title,
			});
		}
	}
	return results;
}
