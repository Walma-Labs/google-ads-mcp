// Server tests: drive the real MCP wire (in-memory transport) against a mocked
// request function. Proves tool registration, zod schemas, the URL, headers and
// body sent to Google, and the response mapping, without network or credentials.

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGoogleAdsServer } from "../src/server.js";
import { createGoogleAdsClient, type RequestFn } from "../src/googleAds.js";

type Call = Parameters<RequestFn>[0];

function fixture(respond: (call: Call) => unknown, options: Record<string, string | boolean> = { developerToken: "dev-token" }) {
  const calls: Call[] = [];
  const request: RequestFn = async (call) => {
    calls.push(call);
    return { data: respond(call) };
  };
  return { client: createGoogleAdsClient(request, { apiVersion: "v25", ...options }), calls };
}

async function connect(client: ReturnType<typeof createGoogleAdsClient>, writeLevel: "off" | "draft" | "live" = "off") {
  const server = createGoogleAdsServer(client, { writeLevel });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), mcp.connect(clientT)]);
  return mcp;
}

const text = (r: any) => r.content[0].text as string;
const parse = (r: any) => JSON.parse(text(r));

describe("google-ads MCP server", () => {
  it("registers the three read tools, all marked read-only", async () => {
    const mcp = await connect(fixture(() => ({})).client);
    const { tools } = await mcp.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(["get_resource_metadata", "list_accessible_customers", "search"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    const search = tools.find(t => t.name === "search")!;
    expect(search.inputSchema.required).toEqual(expect.arrayContaining(["customer_id", "fields", "resource"]));
    expect(search.description).toContain("keyword_view");
    expect(search.description).toContain("get_resource_metadata");
  });

  it("lists accessible customers as bare ids", async () => {
    const { client, calls } = fixture(() => ({ resourceNames: ["customers/1234567890", "customers/22"] }));
    const mcp = await connect(client);
    expect(parse(await mcp.callTool({ name: "list_accessible_customers", arguments: {} }))).toEqual(["1234567890", "22"]);
    expect(calls[0]).toMatchObject({
      url: "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers",
      method: "GET",
      headers: { "developer-token": "dev-token" },
    });
  });

  it("search sends the GAQL query and returns rows keyed by the selected fields", async () => {
    const { client, calls } = fixture(() => ({
      results: [{ campaign: { name: "Brand" }, metrics: { costMicros: "2500000" } }],
    }));
    const mcp = await connect(client);
    const out = parse(await mcp.callTool({ name: "search", arguments: {
      customer_id: "123-456-7890",
      fields: ["campaign.name", "metrics.cost_micros"],
      resource: "campaign",
      conditions: ["segments.date DURING LAST_30_DAYS"],
      login_customer_id: "999-000-1111",
    } }));
    expect(out).toEqual({ rows: [{ "campaign.name": "Brand", "metrics.cost_micros": "2500000" }], row_count: 1 });
    expect(calls[0]).toEqual({
      url: "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search",
      method: "POST",
      data: { query: "SELECT campaign.name,metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS PARAMETERS omit_unselected_resource_names=true" },
      headers: { "developer-token": "dev-token", "login-customer-id": "9990001111" },
    });
  });

  it("says so when there were more rows than one page", async () => {
    const { client } = fixture(() => ({ results: [{ campaign: { id: "1" } }], nextPageToken: "more" }));
    const mcp = await connect(client);
    const out = parse(await mcp.callTool({ name: "search", arguments: { customer_id: 1, fields: ["campaign.id"], resource: "campaign" } }));
    expect(out).toMatchObject({ row_count: 1, truncated: true });
  });

  it("uses the configured manager account when the call names none", async () => {
    const { client, calls } = fixture(() => ({ results: [] }), { developerToken: "dev-token", loginCustomerId: "111-222-3333" });
    const mcp = await connect(client);
    await mcp.callTool({ name: "search", arguments: { customer_id: 1, fields: ["campaign.id"], resource: "campaign" } });
    expect(calls[0]!.headers).toEqual({ "developer-token": "dev-token", "login-customer-id": "1112223333" });
  });

  describe("locked to one manager account", () => {
    const lockedTo = { developerToken: "dev-token", loginCustomerId: "111-222-3333", lockLoginCustomer: true };

    it("lists only that manager, whatever else the service account reaches", async () => {
      const { client } = fixture(() => ({ resourceNames: ["customers/1112223333", "customers/9998887777"] }), lockedTo);
      const mcp = await connect(client);
      expect(parse(await mcp.callTool({ name: "list_accessible_customers", arguments: {} }))).toEqual(["1112223333"]);
    });

    it("always goes through that manager", async () => {
      const { client, calls } = fixture(() => ({ results: [] }), lockedTo);
      const mcp = await connect(client);
      await mcp.callTool({ name: "search", arguments: { customer_id: 5, fields: ["campaign.id"], resource: "campaign" } });
      await mcp.callTool({ name: "search", arguments: { customer_id: 5, fields: ["campaign.id"], resource: "campaign", login_customer_id: "111-222-3333" } });
      expect(calls.map(c => c.headers!["login-customer-id"])).toEqual(["1112223333", "1112223333"]);
    });

    it("refuses another login account without calling Google", async () => {
      const { client, calls } = fixture(() => ({ results: [] }), lockedTo);
      const mcp = await connect(client);
      const res: any = await mcp.callTool({ name: "search", arguments: {
        customer_id: "9998887777", fields: ["campaign.id"], resource: "campaign", login_customer_id: "9998887777",
      } });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain("1112223333");
      expect(calls).toHaveLength(0);
    });

    it("refuses every call when no manager is configured", async () => {
      const { client, calls } = fixture(() => ({ results: [] }), { developerToken: "dev-token", loginCustomerId: "", lockLoginCustomer: true });
      const mcp = await connect(client);
      const res: any = await mcp.callTool({ name: "search", arguments: { customer_id: 5, fields: ["campaign.id"], resource: "campaign" } });
      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
    });

    it("mutate is fenced the same way", async () => {
      const { client, calls } = fixture(() => ({}), lockedTo);
      await expect(client.mutate("5", [], { loginCustomerId: "9998887777" })).rejects.toThrow("1112223333");
      await client.mutate("5", [], { validateOnly: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.headers!["login-customer-id"]).toBe("1112223333");
    });
  });

  it("get_resource_metadata merges attributes with compatible metrics and segments, following pages", async () => {
    const { client, calls } = fixture((call) => {
      const { query, pageToken } = call.data as { query: string; pageToken?: string };
      if (query.includes("category = 'ATTRIBUTE'")) {
        return pageToken
          ? { results: [{ name: "campaign.name", selectable: true, filterable: true, sortable: true }] }
          : { results: [{ name: "campaign.id", selectable: true, filterable: true, sortable: true }], nextPageToken: "p2" };
      }
      return { results: [{ name: "metrics.clicks", selectable: true, filterable: true, sortable: true }] };
    });
    const mcp = await connect(client);
    const out = parse(await mcp.callTool({ name: "get_resource_metadata", arguments: { resource_name: "campaign" } }));
    expect(out.selectable).toEqual(["campaign.id", "campaign.name", "metrics.clicks"]);
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.url === "https://googleads.googleapis.com/v25/googleAdsFields:search")).toBe(true);
  });

  it("returns the API's own error text instead of throwing", async () => {
    const request: RequestFn = async () => {
      throw Object.assign(new Error("Request failed with status code 400"), { response: { data: { error: {
        message: "Request contains an invalid argument.",
        details: [{ requestId: "req-1", errors: [{ message: "Unrecognized field in the query: 'campaign.nam'." }] }],
      } } } });
    };
    const mcp = await connect(createGoogleAdsClient(request, { developerToken: "dev-token" }));
    const res: any = await mcp.callTool({ name: "search", arguments: { customer_id: 1, fields: ["campaign.nam"], resource: "campaign" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Request ID: req-1\nGoogle Ads API Error: Unrecognized field in the query: 'campaign.nam'.");
  });

  it("refuses a malformed field before calling Google", async () => {
    const { client, calls } = fixture(() => ({}));
    const mcp = await connect(client);
    const res: any = await mcp.callTool({ name: "search", arguments: { customer_id: 1, fields: ["id"], resource: "campaign" } });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("fails with a clear message when the developer token is missing", async () => {
    const saved = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    try {
      const mcp = await connect(createGoogleAdsClient(async () => ({ data: {} }), {}));
      const res: any = await mcp.callTool({ name: "list_accessible_customers", arguments: {} });
      expect(res.isError).toBe(true);
      expect(text(res)).toBe("GOOGLE_ADS_DEVELOPER_TOKEN is not set");
    } finally {
      if (saved !== undefined) process.env.GOOGLE_ADS_DEVELOPER_TOKEN = saved;
    }
  });
});

describe("mutate", () => {
  const paused = [
    { campaignBudgetOperation: { create: { resourceName: "customers/1234567890/campaignBudgets/-1", name: "B", amountMicros: "50000000", explicitlyShared: false } } },
    { campaignOperation: { create: { name: "PMax", status: "PAUSED", advertisingChannelType: "PERFORMANCE_MAX", campaignBudget: "customers/1234567890/campaignBudgets/-1" } } },
  ];

  it("does not exist unless writing is switched on", async () => {
    const mcp = await connect(fixture(() => ({})).client);
    const { tools } = await mcp.listTools();
    expect(tools.map(t => t.name)).not.toContain("mutate");
    const res: any = await mcp.callTool({ name: "mutate", arguments: { customer_id: 1, operations: paused, validate_only: false } });
    expect(res.isError).toBe(true);
  });

  it("is registered as a destructive tool when switched on, and follows the environment by default", async () => {
    const mcp = await connect(fixture(() => ({})).client, "draft");
    const tool = (await mcp.listTools()).tools.find(t => t.name === "mutate")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool.description).toContain("not possible here");

    const saved = process.env.GOOGLE_ADS_WRITE_TOOLS;
    try {
      process.env.GOOGLE_ADS_WRITE_TOOLS = "live";
      const server = createGoogleAdsServer(fixture(() => ({})).client);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "test", version: "0.0.0" });
      await Promise.all([server.connect(serverT), c.connect(clientT)]);
      expect((await c.listTools()).tools.find(t => t.name === "mutate")!.description).toContain("start or change real spending");
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_ADS_WRITE_TOOLS; else process.env.GOOGLE_ADS_WRITE_TOOLS = saved;
    }
  });

  it("validates by default and changes nothing", async () => {
    const { client, calls } = fixture(() => ({}));
    const mcp = await connect(client, "draft");
    const out = parse(await mcp.callTool({ name: "mutate", arguments: { customer_id: "123-456-7890", operations: paused } }));
    expect(out).toMatchObject({ validated: true, applied: false, operations: 2 });
    expect(calls[0]).toEqual({
      url: "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:mutate",
      method: "POST",
      data: { mutateOperations: paused, validateOnly: true, partialFailure: false },
      headers: { "developer-token": "dev-token" },
    });
  });

  it("applies when told to, atomically, and reports what was created", async () => {
    const { client, calls } = fixture(() => ({ mutateOperationResponses: [
      { campaignBudgetResult: { resourceName: "customers/1234567890/campaignBudgets/9" } },
      { campaignResult: { resourceName: "customers/1234567890/campaigns/5" } },
    ] }));
    const mcp = await connect(client, "draft");
    const out = parse(await mcp.callTool({ name: "mutate", arguments: { customer_id: 1234567890, operations: paused, validate_only: false } }));
    expect(out).toEqual({ applied: true, results: [
      { operation: "campaignBudget", action: "create", resource_name: "customers/1234567890/campaignBudgets/9" },
      { operation: "campaign", action: "create", resource_name: "customers/1234567890/campaigns/5" },
    ] });
    expect((calls[0]!.data as any).validateOnly).toBe(false);
    expect((calls[0]!.data as any).partialFailure).toBe(false);
  });

  it("refuses a rule-breaking batch without calling Google", async () => {
    const { client, calls } = fixture(() => ({}));
    const mcp = await connect(client, "draft");
    const res: any = await mcp.callTool({ name: "mutate", arguments: { customer_id: 1, validate_only: false, operations: [
      { campaignOperation: { update: { resourceName: "customers/1/campaigns/5", status: "ENABLED" }, updateMask: "status" } },
    ] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/enabling a campaign starts spending/);
    expect(calls).toHaveLength(0);
  });
});
