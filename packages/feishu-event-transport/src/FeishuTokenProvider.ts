/**
 * Mints and caches Feishu `tenant_access_token`s and resolves the bot's own
 * `open_id`.
 *
 * Unlike Slack (which uses a long-lived static bot token carried in the webhook
 * payload), Feishu bot API calls authenticate with a short-lived
 * `tenant_access_token` obtained from the app's `app_id` + `app_secret`. The
 * token is cached and refreshed shortly before it expires.
 *
 * @see https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
 * @see https://open.feishu.cn/document/server-docs/application-v6/application/bot-v3/info
 */

/** Default Feishu open-platform base URL (feishu.cn). Lark international is `https://open.larksuite.com/open-apis`. */
export const FEISHU_DEFAULT_BASE_URL = "https://open.feishu.cn/open-apis";

export interface FeishuTokenProviderOptions {
	/** Feishu app id (e.g. "cli_...") */
	appId: string;
	/** Feishu app secret */
	appSecret: string;
	/** Open-platform base URL (default {@link FEISHU_DEFAULT_BASE_URL}) */
	baseUrl?: string;
}

export class FeishuTokenProvider {
	private readonly appId: string;
	private readonly appSecret: string;
	private readonly baseUrl: string;

	private cachedToken: string | undefined;
	/** Epoch ms at which the cached token should be considered stale. */
	private tokenExpiresAt = 0;
	private cachedBotOpenId: string | undefined;
	/** De-dupes concurrent token refreshes into a single in-flight request. */
	private inflight: Promise<string> | undefined;

	/** Refresh the token this many ms before its stated expiry. */
	private static readonly REFRESH_SKEW_MS = 5 * 60 * 1000;

	constructor(options: FeishuTokenProviderOptions) {
		this.appId = options.appId;
		this.appSecret = options.appSecret;
		this.baseUrl = (options.baseUrl ?? FEISHU_DEFAULT_BASE_URL).replace(
			/\/+$/,
			"",
		);
	}

	/**
	 * Get a valid `tenant_access_token`, minting a fresh one when the cached
	 * token is missing or within the refresh skew of expiry.
	 */
	async getTenantAccessToken(): Promise<string> {
		if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
			return this.cachedToken;
		}
		if (this.inflight) {
			return this.inflight;
		}
		this.inflight = this.mintToken().finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	private async mintToken(): Promise<string> {
		const url = `${this.baseUrl}/auth/v3/tenant_access_token/internal`;
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				app_id: this.appId,
				app_secret: this.appSecret,
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[FeishuTokenProvider] Failed to mint tenant_access_token: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		const body = (await response.json()) as {
			code: number;
			msg?: string;
			tenant_access_token?: string;
			expire?: number;
		};

		if (body.code !== 0 || !body.tenant_access_token) {
			throw new Error(
				`[FeishuTokenProvider] Feishu API error minting token: code=${body.code} msg=${body.msg ?? "unknown"}`,
			);
		}

		this.cachedToken = body.tenant_access_token;
		// `expire` is in seconds (typically 7200). Refresh a bit early.
		const expireMs = (body.expire ?? 7200) * 1000;
		this.tokenExpiresAt =
			Date.now() + Math.max(0, expireMs - FeishuTokenProvider.REFRESH_SKEW_MS);
		return this.cachedToken;
	}

	/** Return the bot's `open_id` if it has already been resolved. */
	getCachedBotOpenId(): string | undefined {
		return this.cachedBotOpenId;
	}

	/**
	 * Resolve (and cache) the bot's own `open_id` via `/bot/v3/info`. Best-effort:
	 * returns undefined and does not throw on failure, since mention detection has
	 * a group-heuristic fallback.
	 */
	async resolveBotOpenId(): Promise<string | undefined> {
		if (this.cachedBotOpenId) {
			return this.cachedBotOpenId;
		}
		try {
			const token = await this.getTenantAccessToken();
			const url = `${this.baseUrl}/bot/v3/info`;
			const response = await fetch(url, {
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) {
				return undefined;
			}
			const body = (await response.json()) as {
				code: number;
				bot?: { open_id?: string };
			};
			if (body.code === 0 && body.bot?.open_id) {
				this.cachedBotOpenId = body.bot.open_id;
			}
			return this.cachedBotOpenId;
		} catch {
			return undefined;
		}
	}
}
