/**
 * Minimal Feishu (Lark) document reader used by the `feishu_read_document`
 * cyrus-tool. Reads the text content of a Feishu **docx** document or a **wiki**
 * page (which is resolved to its underlying docx), and the structured content of
 * a **Bitable** (多维表格 / base — data tables, fields and records). Authenticates
 * with the app's `tenant_access_token` minted from FEISHU_APP_ID / FEISHU_APP_SECRET.
 *
 * Self-contained (plain `fetch`, no SDK/fastify) so the published `cyrus-mcp-tools`
 * package stays lean. Validated against the live Feishu API:
 * - GET /open-apis/wiki/v2/spaces/get_node?token=<node_token> → data.node.{obj_type, obj_token, title}
 * - GET /open-apis/docx/v1/documents/<document_id>/raw_content → data.content
 * - GET /open-apis/docx/v1/documents/<document_id> → data.document.title
 * - GET /open-apis/bitable/v1/apps/<app_token> → data.app.name
 * - GET /open-apis/bitable/v1/apps/<app_token>/tables → data.items[].{table_id, name}
 * - GET /open-apis/bitable/v1/apps/<app_token>/tables/<table_id>/fields → data.items[].{field_id, field_name, type}
 * - GET /open-apis/bitable/v1/apps/<app_token>/tables/<table_id>/records → data.items[].{record_id, fields}
 */

/** Default Feishu open-platform base URL (feishu.cn). */
const FEISHU_DEFAULT_BASE_URL = "https://open.feishu.cn/open-apis";

/** Default number of records read per Bitable table when not overridden. */
const DEFAULT_BITABLE_MAX_RECORDS = 100;
/** Hard cap on records read per Bitable table (protects prompt size / rate limits). */
const BITABLE_MAX_RECORDS_LIMIT = 500;
/** Feishu record-list page size cap. */
const BITABLE_RECORD_PAGE_SIZE = 500;
/** Feishu table/field-list page size cap. */
const BITABLE_LIST_PAGE_SIZE = 100;
/** Safety cap on how many tables we fully read (fields + records) in one call. */
const BITABLE_MAX_TABLES_READ = 20;

/** Reference to a Feishu document parsed from a URL or raw token. */
export interface FeishuDocRef {
	/** Document family inferred from the URL path (or defaulted). */
	type: "wiki" | "docx" | "doc" | "sheet" | "bitable" | "unknown";
	/** The token (node_token for wiki, document_id for docx, etc.). */
	token: string;
	/** True when the type was determined from an explicit URL path (not defaulted). */
	explicit: boolean;
}

/** A single field (column) definition of a Bitable data table. */
export interface FeishuBitableField {
	field_id?: string;
	field_name?: string;
	/** Feishu field type code (1=text, 2=number, 11=user, …). */
	type?: number;
	/** Human-readable field type when the API provides one (newer API). */
	ui_type?: string;
}

/** A single record (row) of a Bitable data table. */
export interface FeishuBitableRecord {
	record_id?: string;
	/** Map of field name → cell value (shape depends on the field type). */
	fields?: Record<string, unknown>;
}

/** Structured content of a single Bitable data table. */
export interface FeishuBitableTable {
	table_id: string;
	name?: string;
	/** Field/column definitions. Empty when the table was only listed, not read. */
	fields: FeishuBitableField[];
	/** Records (rows), capped by `maxRecords`. Empty when only listed. */
	records: FeishuBitableRecord[];
	/** True when more records exist beyond the returned `records`. */
	hasMoreRecords: boolean;
}

/** Structured content of a Bitable (base) app: its data tables. */
export interface FeishuBitableResult {
	app_token: string;
	name?: string;
	/** Total number of data tables in the base. */
	tableCount: number;
	/** The tables that were read (or just listed — see each table's `fields`). */
	tables: FeishuBitableTable[];
}

export interface FeishuReadDocumentResult {
	/** Resolved document family that was actually read. */
	docType: "docx" | "sheet" | "bitable" | "mindnote" | "file" | "unknown";
	/** Token of the underlying object that was read (e.g. resolved docx id). */
	token: string;
	/** Document title, when available. */
	title?: string;
	/** Plain-text content, present for docx. */
	text?: string;
	/** Structured content, present for bitable (base). */
	bitable?: FeishuBitableResult;
	/** Explanation when the content type is not supported for reading. */
	note?: string;
}

/** Options controlling how {@link FeishuDocsClient.readDocument} reads a base. */
export interface FeishuReadDocumentOptions {
	/** Read only this Bitable data table (table id, e.g. `tblXXXX`). */
	tableId?: string;
	/** Max records to read per table (default 100, capped at 500). */
	maxRecords?: number;
}

/**
 * Parse a Feishu document URL or raw token into a {@link FeishuDocRef}.
 * Recognizes `/wiki/`, `/docx/`, `/docs/`, `/sheets/`, `/base/` (bitable) URLs;
 * a bare token defaults to `docx` (non-explicit, so callers may fall back to wiki).
 */
export function parseFeishuDocRef(urlOrToken: string): FeishuDocRef {
	const trimmed = (urlOrToken || "").trim();
	const patterns: Array<[FeishuDocRef["type"], RegExp]> = [
		["wiki", /\/wiki\/([A-Za-z0-9]+)/],
		["docx", /\/docx\/([A-Za-z0-9]+)/],
		["doc", /\/docs\/([A-Za-z0-9]+)/],
		["sheet", /\/sheets\/([A-Za-z0-9]+)/],
		["bitable", /\/(?:base|bitable)\/([A-Za-z0-9]+)/],
	];
	for (const [type, re] of patterns) {
		const m = trimmed.match(re);
		if (m?.[1]) return { type, token: m[1], explicit: true };
	}
	// Bare token: strip any query/hash, default to docx (non-explicit).
	const token = trimmed.replace(/[?#].*$/, "");
	return { type: "docx", token, explicit: false };
}

/**
 * Extract the Bitable data-table id from a base URL's `table=` query param, if
 * present. Feishu base links look like
 * `https://x.feishu.cn/base/<app_token>?table=<table_id>&view=<view_id>`.
 * Returns `undefined` when no table id is present.
 */
export function parseFeishuTableId(urlOrToken: string): string | undefined {
	const m = (urlOrToken || "").match(/[?&]table=(tbl[A-Za-z0-9]+)/);
	return m?.[1];
}

interface FeishuWikiNode {
	obj_type?: string;
	obj_token?: string;
	title?: string;
}

export class FeishuDocsClient {
	private readonly appId: string;
	private readonly appSecret: string;
	private readonly baseUrl: string;
	private cachedToken: string | undefined;
	private tokenExpiresAt = 0;

	constructor(appId: string, appSecret: string, baseUrl?: string) {
		this.appId = appId;
		this.appSecret = appSecret;
		this.baseUrl = (baseUrl ?? FEISHU_DEFAULT_BASE_URL).replace(/\/+$/, "");
	}

	/**
	 * Read a Feishu docx or wiki document into plain text, or a Bitable (base)
	 * into structured tables/fields/records. Sheet references return a `note`.
	 */
	async readDocument(
		urlOrToken: string,
		options?: FeishuReadDocumentOptions,
	): Promise<FeishuReadDocumentResult> {
		const ref = parseFeishuDocRef(urlOrToken);

		if (ref.type === "wiki") {
			return this.readWiki(ref.token, options);
		}

		if (ref.type === "bitable") {
			const tableId = options?.tableId ?? parseFeishuTableId(urlOrToken);
			return this.readBitable(ref.token, {
				...options,
				tableId,
			});
		}

		if (ref.type === "docx" || ref.type === "doc") {
			try {
				const { title, text } = await this.readDocx(ref.token);
				return { docType: "docx", token: ref.token, title, text };
			} catch (error) {
				// A bare token we defaulted to docx might actually be a wiki node —
				// retry as wiki before giving up.
				if (!ref.explicit) {
					try {
						return await this.readWiki(ref.token, options);
					} catch {
						// fall through to rethrow the original docx error
					}
				}
				throw error;
			}
		}

		return {
			docType: "sheet",
			token: ref.token,
			note: `Reading '${ref.type}' content is not supported yet — only Feishu docs (docx), wiki pages and bitable (base) can be read. Token: ${ref.token}`,
		};
	}

	private async readWiki(
		nodeToken: string,
		options?: FeishuReadDocumentOptions,
	): Promise<FeishuReadDocumentResult> {
		const node = await this.resolveWikiNode(nodeToken);
		if (node.obj_type === "docx" || node.obj_type === "doc") {
			const { title, text } = await this.readDocx(node.obj_token ?? "");
			return {
				docType: "docx",
				token: node.obj_token ?? nodeToken,
				title: node.title || title,
				text,
			};
		}
		if (node.obj_type === "bitable") {
			const result = await this.readBitable(node.obj_token ?? "", options);
			// Prefer the wiki node's title when the base itself has none.
			return { ...result, title: result.title || node.title };
		}
		return {
			docType:
				(node.obj_type as FeishuReadDocumentResult["docType"]) ?? "unknown",
			token: node.obj_token ?? nodeToken,
			title: node.title,
			note: `This wiki page is a '${node.obj_type ?? "unknown"}', whose content reading is not supported yet (only docx and bitable wiki pages can be read). Object token: ${node.obj_token ?? nodeToken}`,
		};
	}

	private async resolveWikiNode(nodeToken: string): Promise<FeishuWikiNode> {
		const url = `${this.baseUrl}/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`;
		const body = await this.get(url);
		const node = body?.data?.node as FeishuWikiNode | undefined;
		if (!node?.obj_token) {
			throw new Error(
				`Wiki node not found or the Cyrus bot lacks access: ${nodeToken}`,
			);
		}
		return node;
	}

	private async readDocx(
		documentId: string,
	): Promise<{ title?: string; text: string }> {
		const contentBody = await this.get(
			`${this.baseUrl}/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
		);
		const text = (contentBody?.data?.content as string) ?? "";

		let title: string | undefined;
		try {
			const metaBody = await this.get(
				`${this.baseUrl}/docx/v1/documents/${encodeURIComponent(documentId)}`,
			);
			title = metaBody?.data?.document?.title as string | undefined;
		} catch {
			// title is best-effort
		}

		return { title, text };
	}

	/**
	 * Read a Bitable (base) app into structured tables/fields/records.
	 *
	 * - With `options.tableId`: reads just that one data table.
	 * - Without it: lists all data tables and reads each one's fields + records
	 *   (up to {@link BITABLE_MAX_TABLES_READ} tables). Records per table are
	 *   capped by `options.maxRecords`.
	 */
	async readBitable(
		appToken: string,
		options?: FeishuReadDocumentOptions,
	): Promise<FeishuReadDocumentResult> {
		if (!appToken) {
			throw new Error("[FeishuDocsClient] Missing bitable app token");
		}
		const maxRecords = Math.min(
			Math.max(1, options?.maxRecords ?? DEFAULT_BITABLE_MAX_RECORDS),
			BITABLE_MAX_RECORDS_LIMIT,
		);

		// App name is best-effort — a base can be read even if meta is unavailable.
		let name: string | undefined;
		try {
			const meta = await this.get(
				`${this.baseUrl}/bitable/v1/apps/${encodeURIComponent(appToken)}`,
			);
			name = meta?.data?.app?.name as string | undefined;
		} catch {
			// ignore; name stays undefined
		}

		const allTables = await this.listBitableTables(appToken);
		const base: FeishuBitableResult = {
			app_token: appToken,
			name,
			tableCount: allTables.length,
			tables: [],
		};

		if (allTables.length === 0) {
			return {
				docType: "bitable",
				token: appToken,
				title: name,
				bitable: base,
				note: "This Feishu base has no data tables.",
			};
		}

		// Choose which tables to fully read.
		let targets = allTables;
		let note: string | undefined;
		if (options?.tableId) {
			targets = allTables.filter((t) => t.table_id === options.tableId);
			if (targets.length === 0) {
				const available = allTables
					.map((t) => `${t.name ?? "(unnamed)"} (${t.table_id})`)
					.join(", ");
				return {
					docType: "bitable",
					token: appToken,
					title: name,
					bitable: {
						...base,
						tables: allTables.map((t) => ({
							table_id: t.table_id,
							name: t.name,
							fields: [],
							records: [],
							hasMoreRecords: false,
						})),
					},
					note: `Table '${options.tableId}' was not found in this base. Available tables: ${available}. Re-run with one of these table ids.`,
				};
			}
		} else if (allTables.length > BITABLE_MAX_TABLES_READ) {
			targets = allTables.slice(0, BITABLE_MAX_TABLES_READ);
			note = `This base has ${allTables.length} data tables; only the first ${BITABLE_MAX_TABLES_READ} were read. Re-run with a specific tableId to read the others.`;
		}

		const tables: FeishuBitableTable[] = [];
		for (const table of targets) {
			const [fields, records] = await Promise.all([
				this.listBitableFields(appToken, table.table_id),
				this.listBitableRecords(appToken, table.table_id, maxRecords),
			]);
			tables.push({
				table_id: table.table_id,
				name: table.name,
				fields,
				records: records.items,
				hasMoreRecords: records.hasMore,
			});
		}

		return {
			docType: "bitable",
			token: appToken,
			title: name,
			bitable: { ...base, tables },
			...(note ? { note } : {}),
		};
	}

	private async listBitableTables(
		appToken: string,
	): Promise<Array<{ table_id: string; name?: string }>> {
		const tables: Array<{ table_id: string; name?: string }> = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				page_size: String(BITABLE_LIST_PAGE_SIZE),
			});
			if (pageToken) params.set("page_token", pageToken);
			const body = await this.get(
				`${this.baseUrl}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?${params}`,
			);
			const items =
				(body?.data?.items as
					| Array<{ table_id?: string; name?: string }>
					| undefined) ?? [];
			for (const item of items) {
				if (item.table_id) {
					tables.push({ table_id: item.table_id, name: item.name });
				}
			}
			pageToken = body?.data?.has_more
				? (body?.data?.page_token as string | undefined)
				: undefined;
		} while (pageToken);
		return tables;
	}

	private async listBitableFields(
		appToken: string,
		tableId: string,
	): Promise<FeishuBitableField[]> {
		const fields: FeishuBitableField[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				page_size: String(BITABLE_LIST_PAGE_SIZE),
			});
			if (pageToken) params.set("page_token", pageToken);
			const body = await this.get(
				`${this.baseUrl}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields?${params}`,
			);
			const items =
				(body?.data?.items as FeishuBitableField[] | undefined) ?? [];
			for (const item of items) {
				fields.push({
					field_id: item.field_id,
					field_name: item.field_name,
					type: item.type,
					ui_type: item.ui_type,
				});
			}
			pageToken = body?.data?.has_more
				? (body?.data?.page_token as string | undefined)
				: undefined;
		} while (pageToken);
		return fields;
	}

	private async listBitableRecords(
		appToken: string,
		tableId: string,
		maxRecords: number,
	): Promise<{ items: FeishuBitableRecord[]; hasMore: boolean }> {
		const records: FeishuBitableRecord[] = [];
		let pageToken: string | undefined;
		let hasMore = false;
		do {
			const remaining = maxRecords - records.length;
			const pageSize = Math.min(remaining, BITABLE_RECORD_PAGE_SIZE);
			const params = new URLSearchParams({ page_size: String(pageSize) });
			if (pageToken) params.set("page_token", pageToken);
			const body = await this.get(
				`${this.baseUrl}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?${params}`,
			);
			const items =
				(body?.data?.items as FeishuBitableRecord[] | undefined) ?? [];
			for (const item of items) {
				records.push({ record_id: item.record_id, fields: item.fields });
			}
			const apiHasMore = Boolean(body?.data?.has_more);
			pageToken = apiHasMore
				? (body?.data?.page_token as string | undefined)
				: undefined;
			// Stop once we've reached the cap; flag truncation if the API has more.
			if (records.length >= maxRecords) {
				hasMore = apiHasMore;
				break;
			}
		} while (pageToken);
		return { items: records, hasMore };
	}

	private async get(url: string): Promise<{
		code?: number;
		msg?: string;
		// Feishu APIs return heterogeneous `data` shapes across endpoints
		// (wiki node, docx content, bitable tables/fields/records) — keep it loose
		// and let each caller narrow the fields it needs.
		data?: any;
	}> {
		const token = await this.getTenantAccessToken();
		const response = await fetch(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[FeishuDocsClient] GET failed: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}
		const body = (await response.json()) as { code?: number; msg?: string };
		if (body.code !== 0) {
			throw new Error(
				`[FeishuDocsClient] Feishu API error: code=${body.code} msg=${body.msg ?? "unknown"}`,
			);
		}
		return body as Awaited<ReturnType<FeishuDocsClient["get"]>>;
	}

	private async getTenantAccessToken(): Promise<string> {
		if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
			return this.cachedToken;
		}
		const response = await fetch(
			`${this.baseUrl}/auth/v3/tenant_access_token/internal`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json; charset=utf-8" },
				body: JSON.stringify({
					app_id: this.appId,
					app_secret: this.appSecret,
				}),
			},
		);
		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[FeishuDocsClient] Failed to mint tenant_access_token: ${response.status} ${response.statusText} - ${errorBody}`,
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
				`[FeishuDocsClient] Feishu API error minting token: code=${body.code} msg=${body.msg ?? "unknown"}`,
			);
		}
		this.cachedToken = body.tenant_access_token;
		// `expire` is seconds; refresh 5 min early.
		this.tokenExpiresAt =
			Date.now() + Math.max(0, (body.expire ?? 7200) * 1000 - 5 * 60 * 1000);
		return this.cachedToken;
	}
}
