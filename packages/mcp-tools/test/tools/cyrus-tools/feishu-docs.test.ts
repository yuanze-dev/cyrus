import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FeishuDocsClient,
	parseFeishuDocRef,
	parseFeishuTableId,
} from "../../../src/tools/cyrus-tools/feishu-docs.js";

/** Build a fetch mock that routes by URL substring. */
function routedFetch(
	routes: Array<{
		match: string;
		body: unknown;
		ok?: boolean;
		status?: number;
	}>,
) {
	return vi.fn(async (url: string) => {
		const route = routes.find((r) => url.includes(r.match));
		if (!route) throw new Error(`No route for ${url}`);
		return {
			ok: route.ok ?? true,
			status: route.status ?? 200,
			statusText: "OK",
			text: async () => JSON.stringify(route.body),
			json: async () => route.body,
		};
	});
}

const TOKEN_ROUTE = {
	match: "/auth/v3/tenant_access_token/internal",
	body: { code: 0, tenant_access_token: "t_abc", expire: 7200 },
};

describe("parseFeishuDocRef", () => {
	it("detects docx / wiki / sheets / base URLs", () => {
		expect(parseFeishuDocRef("https://x.feishu.cn/docx/AbC123")).toMatchObject({
			type: "docx",
			token: "AbC123",
			explicit: true,
		});
		expect(parseFeishuDocRef("https://x.feishu.cn/wiki/W1k2")).toMatchObject({
			type: "wiki",
			token: "W1k2",
			explicit: true,
		});
		expect(
			parseFeishuDocRef("https://x.feishu.cn/sheets/Sh33t?sheet=1"),
		).toMatchObject({ type: "sheet", token: "Sh33t", explicit: true });
		expect(parseFeishuDocRef("https://x.feishu.cn/base/Ba5e")).toMatchObject({
			type: "bitable",
			token: "Ba5e",
			explicit: true,
		});
	});

	it("defaults a bare token to docx (non-explicit)", () => {
		expect(parseFeishuDocRef("doxcnAbc123")).toMatchObject({
			type: "docx",
			token: "doxcnAbc123",
			explicit: false,
		});
	});
});

describe("parseFeishuTableId", () => {
	it("extracts the table id from a base URL's table= query param", () => {
		expect(
			parseFeishuTableId(
				"https://x.feishu.cn/base/Ba5e?table=tblAbc123&view=vew1",
			),
		).toBe("tblAbc123");
	});

	it("returns undefined when there is no table query param", () => {
		expect(parseFeishuTableId("https://x.feishu.cn/base/Ba5e")).toBeUndefined();
		expect(parseFeishuTableId("Ba5e")).toBeUndefined();
	});
});

describe("FeishuDocsClient.readDocument", () => {
	afterEach(() => vi.restoreAllMocks());

	it("reads a docx URL: mints token, returns content + title", async () => {
		const fetchMock = routedFetch([
			TOKEN_ROUTE,
			{
				match: "/docx/v1/documents/DocX1/raw_content",
				body: { code: 0, data: { content: "Hello world body" } },
			},
			{
				match: "/docx/v1/documents/DocX1",
				body: { code: 0, data: { document: { title: "My Doc" } } },
			},
		]);
		vi.stubGlobal("fetch", fetchMock);

		const client = new FeishuDocsClient("cli_app", "secret");
		const result = await client.readDocument("https://x.feishu.cn/docx/DocX1");

		expect(result).toMatchObject({
			docType: "docx",
			token: "DocX1",
			title: "My Doc",
			text: "Hello world body",
		});
		// tenant token was minted with the app credentials
		const tokenCall = fetchMock.mock.calls.find((c) =>
			(c[0] as string).includes("tenant_access_token"),
		);
		expect(JSON.parse((tokenCall?.[1] as { body: string }).body)).toEqual({
			app_id: "cli_app",
			app_secret: "secret",
		});
	});

	it("reads a wiki URL: resolves the node to its docx, then reads it", async () => {
		const fetchMock = routedFetch([
			TOKEN_ROUTE,
			{
				match: "/wiki/v2/spaces/get_node",
				body: {
					code: 0,
					data: {
						node: {
							obj_type: "docx",
							obj_token: "DocXfromWiki",
							title: "Wiki Title",
						},
					},
				},
			},
			{
				match: "/docx/v1/documents/DocXfromWiki/raw_content",
				body: { code: 0, data: { content: "wiki body text" } },
			},
			{
				match: "/docx/v1/documents/DocXfromWiki",
				body: { code: 0, data: { document: { title: "Wiki Title" } } },
			},
		]);
		vi.stubGlobal("fetch", fetchMock);

		const client = new FeishuDocsClient("a", "b");
		const result = await client.readDocument("https://x.feishu.cn/wiki/W1");
		expect(result).toMatchObject({
			docType: "docx",
			token: "DocXfromWiki",
			title: "Wiki Title",
			text: "wiki body text",
		});
	});

	it("returns a note for a wiki node that is a sheet (not docx)", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch([
				TOKEN_ROUTE,
				{
					match: "/wiki/v2/spaces/get_node",
					body: {
						code: 0,
						data: {
							node: {
								obj_type: "sheet",
								obj_token: "Sheet1",
								title: "A Sheet",
							},
						},
					},
				},
			]),
		);
		const client = new FeishuDocsClient("a", "b");
		const result = await client.readDocument("https://x.feishu.cn/wiki/W2");
		expect(result.text).toBeUndefined();
		expect(result.note).toContain("sheet");
		expect(result.token).toBe("Sheet1");
	});

	it("returns a note (no read) for a sheet URL", async () => {
		vi.stubGlobal("fetch", routedFetch([TOKEN_ROUTE]));
		const client = new FeishuDocsClient("a", "b");
		const result = await client.readDocument("https://x.feishu.cn/sheets/S1");
		expect(result.docType).toBe("sheet");
		expect(result.note).toContain("not supported");
	});

	it("caches the tenant token across reads", async () => {
		const fetchMock = routedFetch([
			TOKEN_ROUTE,
			{
				match: "/raw_content",
				body: { code: 0, data: { content: "x" } },
			},
			{
				match: "/docx/v1/documents/",
				body: { code: 0, data: { document: { title: "t" } } },
			},
		]);
		vi.stubGlobal("fetch", fetchMock);
		const client = new FeishuDocsClient("a", "b");
		await client.readDocument("https://x.feishu.cn/docx/D1");
		await client.readDocument("https://x.feishu.cn/docx/D2");
		const tokenCalls = fetchMock.mock.calls.filter((c) =>
			(c[0] as string).includes("tenant_access_token"),
		);
		expect(tokenCalls).toHaveLength(1);
	});

	it("surfaces a Feishu API error (code !== 0)", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch([
				TOKEN_ROUTE,
				{
					match: "/raw_content",
					body: { code: 1254005, msg: "no permission" },
				},
			]),
		);
		const client = new FeishuDocsClient("a", "b");
		await expect(
			client.readDocument("https://x.feishu.cn/docx/DENIED"),
		).rejects.toThrow(/code=1254005/);
	});
});

describe("FeishuDocsClient.readDocument (bitable / base)", () => {
	afterEach(() => vi.restoreAllMocks());

	const APP_META_ROUTE = {
		// least specific bitable route — list it last so more specific ones win
		match: "/bitable/v1/apps/App1",
		body: { code: 0, data: { app: { app_token: "App1", name: "My Base" } } },
	};
	const TABLES_ROUTE = {
		match: "/bitable/v1/apps/App1/tables?",
		body: {
			code: 0,
			data: {
				has_more: false,
				items: [
					{ table_id: "tblA", name: "Tasks" },
					{ table_id: "tblB", name: "People" },
				],
			},
		},
	};
	const fieldsRoute = (tableId: string) => ({
		match: `/tables/${tableId}/fields`,
		body: {
			code: 0,
			data: {
				has_more: false,
				items: [
					{ field_id: "fld1", field_name: "Name", type: 1 },
					{ field_id: "fld2", field_name: "Count", type: 2 },
				],
			},
		},
	});
	const recordsRoute = (tableId: string, hasMore = false) => ({
		match: `/tables/${tableId}/records`,
		body: {
			code: 0,
			data: {
				has_more: hasMore,
				page_token: hasMore ? "next" : undefined,
				total: hasMore ? 999 : 2,
				items: [
					{ record_id: "rec1", fields: { Name: "Alice", Count: 3 } },
					{ record_id: "rec2", fields: { Name: "Bob", Count: 7 } },
				],
			},
		},
	});

	it("lists and reads all data tables for a base URL", async () => {
		vi.stubGlobal(
			"fetch",
			// Order matters: more specific field/record routes before the tables
			// list, and the app-meta route last (it's a substring of the others).
			routedFetch([
				TOKEN_ROUTE,
				fieldsRoute("tblA"),
				recordsRoute("tblA"),
				fieldsRoute("tblB"),
				recordsRoute("tblB"),
				TABLES_ROUTE,
				APP_META_ROUTE,
			]),
		);
		const client = new FeishuDocsClient("a", "b");
		const result = await client.readDocument("https://x.feishu.cn/base/App1");

		expect(result.docType).toBe("bitable");
		expect(result.token).toBe("App1");
		expect(result.title).toBe("My Base");
		expect(result.bitable?.tableCount).toBe(2);
		expect(result.bitable?.tables.map((t) => t.table_id)).toEqual([
			"tblA",
			"tblB",
		]);
		const first = result.bitable?.tables[0];
		expect(first?.name).toBe("Tasks");
		expect(first?.fields).toHaveLength(2);
		expect(first?.records).toHaveLength(2);
		expect(first?.records[0]).toMatchObject({
			record_id: "rec1",
			fields: { Name: "Alice", Count: 3 },
		});
		expect(first?.hasMoreRecords).toBe(false);
	});

	it("reads only the requested table via the table= query param", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch([
				TOKEN_ROUTE,
				fieldsRoute("tblB"),
				recordsRoute("tblB"),
				TABLES_ROUTE,
				APP_META_ROUTE,
			]),
		);
		const client = new FeishuDocsClient("a", "b");
		const result = await client.readDocument(
			"https://x.feishu.cn/base/App1?table=tblB&view=vew1",
		);
		expect(result.bitable?.tableCount).toBe(2);
		expect(result.bitable?.tables).toHaveLength(1);
		expect(result.bitable?.tables[0]?.table_id).toBe("tblB");
		expect(result.bitable?.tables[0]?.name).toBe("People");
	});

	it("reads only the requested table via the tableId option", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch([
				TOKEN_ROUTE,
				fieldsRoute("tblA"),
				recordsRoute("tblA"),
				TABLES_ROUTE,
				APP_META_ROUTE,
			]),
		);
		const client = new FeishuDocsClient("a", "b");
		const result = await client.readDocument("https://x.feishu.cn/base/App1", {
			tableId: "tblA",
		});
		expect(result.bitable?.tables).toHaveLength(1);
		expect(result.bitable?.tables[0]?.table_id).toBe("tblA");
	});

	it("returns a note listing available tables for an unknown tableId", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch([TOKEN_ROUTE, TABLES_ROUTE, APP_META_ROUTE]),
		);
		const client = new FeishuDocsClient("a", "b");
		const result = await client.readDocument("https://x.feishu.cn/base/App1", {
			tableId: "tblMissing",
		});
		expect(result.note).toContain("tblMissing");
		expect(result.note).toContain("tblA");
		expect(result.note).toContain("tblB");
		// The available tables are still surfaced (listed, not read).
		expect(result.bitable?.tables).toHaveLength(2);
		expect(result.bitable?.tables[0]?.records).toHaveLength(0);
	});

	it("caps records per table and flags truncation via maxRecords", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch([
				TOKEN_ROUTE,
				fieldsRoute("tblA"),
				recordsRoute("tblA", true),
				TABLES_ROUTE,
				APP_META_ROUTE,
			]),
		);
		const client = new FeishuDocsClient("a", "b");
		const result = await client.readDocument("https://x.feishu.cn/base/App1", {
			tableId: "tblA",
			maxRecords: 2,
		});
		const table = result.bitable?.tables[0];
		expect(table?.records).toHaveLength(2);
		expect(table?.hasMoreRecords).toBe(true);
	});

	it("surfaces a permission error when listing tables (code !== 0)", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch([
				TOKEN_ROUTE,
				{ match: "/bitable/v1/apps/App1?", body: { code: 0, data: {} } },
				{
					match: "/bitable/v1/apps/App1/tables?",
					body: { code: 91402, msg: "NOTEXIST" },
				},
			]),
		);
		const client = new FeishuDocsClient("a", "b");
		await expect(
			client.readDocument("https://x.feishu.cn/base/App1"),
		).rejects.toThrow(/code=91402/);
	});

	it("resolves a wiki node that points at a bitable", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch([
				TOKEN_ROUTE,
				{
					match: "/wiki/v2/spaces/get_node",
					body: {
						code: 0,
						data: {
							node: {
								obj_type: "bitable",
								obj_token: "App1",
								title: "Wiki Base",
							},
						},
					},
				},
				fieldsRoute("tblA"),
				recordsRoute("tblA"),
				fieldsRoute("tblB"),
				recordsRoute("tblB"),
				TABLES_ROUTE,
				{
					match: "/bitable/v1/apps/App1",
					body: { code: 0, data: { app: {} } },
				},
			]),
		);
		const client = new FeishuDocsClient("a", "b");
		const result = await client.readDocument("https://x.feishu.cn/wiki/W3");
		expect(result.docType).toBe("bitable");
		expect(result.token).toBe("App1");
		// Falls back to the wiki node title when the base has none.
		expect(result.title).toBe("Wiki Base");
		expect(result.bitable?.tables).toHaveLength(2);
	});
});
