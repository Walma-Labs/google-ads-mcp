// The MCP server factory: three read-only Google Ads tools on
// @modelcontextprotocol/sdk, with the same names and argument contract as the
// read tools in Google's google-ads-mcp. One implementation, three consumers:
// the stdio bin (local use), the standalone HTTP entrypoint, and the Walma MCP
// chassis (which imports createGoogleAdsServer and mounts it on a path).
//
// Writing is a fourth tool, `mutate`, registered ONLY when the environment
// sets GOOGLE_ADS_WRITE_TOOLS. Without it the tool does not exist, so a client
// cannot call it however it is prompted.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createGoogleAdsClient, MAX_ROWS, type GoogleAdsClient } from "./googleAds.js";
import {
  buildQuery, checkOperations, cleanCustomerId, collectMetadata, flattenRows, formatGoogleAdsError,
  metadataQueries, summarizeMutateResponse, writeLevel, MUTATE_OPERATION_TYPES, type WriteLevel,
} from "./logic.js";
import { GAQL_RESOURCES } from "./resources.js";

export const VERSION = "0.2.0";

export const INSTRUCTIONS =
  "Google Ads data via service account (read-only). Call " +
  "list_accessible_customers first to find customer IDs. Before querying a " +
  "resource, call get_resource_metadata to see which fields, metrics and " +
  "segments it has, then use search. Cost fields are in micros: divide by " +
  "1 000 000 for the account currency.";

const customerId = z.union([z.string(), z.number()])
  .describe("The customer id: digits only. If given as 123-456-7890, remove the hyphens and use 1234567890.");
const loginCustomerId = z.union([z.string(), z.number()]).optional()
  .describe("Optional manager customer ID to use as the login-customer-id header.");

/** JSON tool result in the shape MCP clients expect. */
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(e: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: formatGoogleAdsError(e) }] };
}

const SEARCH_DESCRIPTION = `Fetches data from the Google Ads API using the search method.

Rows come back flattened: one object per row, keyed by the field names you selected.

Language grammar: https://developers.google.com/google-ads/api/docs/query/grammar
All resources and descriptions: https://developers.google.com/google-ads/api/fields/latest/overview
If the query fails, the error from the API is returned with its request id.

To find out which fields (including compatible metrics and segments) you can select, filter by, or sort by for a resource, you MUST use the get_resource_metadata tool. Do not guess the fields.
Use the whole field name (e.g. 'campaign.id', not just 'id'). Wildcards and partial fields are not allowed.

All dates are YYYY-MM-DD and must include the dashes.
Date ranges must be finite and include a start and an end date.

Status fields (campaign.status, ad_group.status, ad_group_criterion.status, ad_group_ad.status) hold the current status, not the status during the date range.
When selecting metrics over a date range, do not filter on status (e.g. campaign.status = 'ENABLED' or campaign.status != 'REMOVED'): entities paused or removed during the range would drop out and totals would understate cost and conversions.
To leave out removed entities with no activity, drop rows with zero impressions after the query instead. Filter on status only when asking what is live now.

Cost and bid fields ending in _micros are in millionths of the account currency.

At most ${MAX_ROWS} rows are returned per call; "truncated": true means there were more. Use limit, a narrower date range or more conditions.
Requests to resource change_event must specify a LIMIT of at most 10000.

For conversion upload issues, look in offline_conversion_upload_conversion_action_summary (https://developers.google.com/google-ads/api/docs/conversions/upload-summaries).

Resources that can be queried:
${GAQL_RESOURCES.join("\n")}`;

const METADATA_DESCRIPTION = `Retrieves the selectable, filterable and sortable fields for a Google Ads resource, including compatible metrics and segments.

Use this to find out which fields you can select, filter by or sort by when querying a resource (e.g. 'campaign', 'ad_group'). Metrics and segments that can be selected with the resource are included; their names start with 'metrics.' and 'segments.'.

Do not guess fields: you MUST use this tool to discover them before constructing a query for the search tool.

The answer does not change often, so reuse it within a conversation.`;

const mutateDescription = (level: WriteLevel) => `Creates, updates or removes campaign building blocks in Google Ads. All operations in a call succeed together or none are applied.

ALWAYS call this twice: first with validate_only left at true, which checks the request against Google Ads without changing anything, then, once it validates and the user has agreed to exactly these changes, again with validate_only: false. Tell the user what will be created or changed before the second call.

operations is a list of MutateOperation objects in the REST (camelCase) form of the Google Ads API, one key each:
  { "campaignBudgetOperation": { "create": { "name": "...", "amountMicros": "50000000", "explicitlyShared": false } } }
  { "campaignOperation": { "update": { "resourceName": "customers/123/campaigns/456", "name": "New name" }, "updateMask": "name" } }
  { "campaignCriterionOperation": { "remove": "customers/123/campaignCriteria/456~789" } }
An update needs updateMask: the comma-separated fields being changed. Enum values are upper-case strings. Amounts ending in Micros are millionths of the account currency, sent as strings.

To refer to something created earlier in the same call, give it a temporary resource name with a negative id (customers/123/campaignBudgets/-1) and use that name in the later operations. Order matters: create a thing before what points at it.

Rules this server enforces before sending:
- A new campaign must have "status": "PAUSED". Nothing is ever created running.
${level === "live"
    ? "- Enabling a campaign and changing an existing budget are allowed here, and start or change real spending. Do either only on the user's explicit instruction."
    : "- Enabling a campaign and changing an existing budget are not possible here: someone does that in Google Ads after reviewing the result."}
- Campaigns, budgets, ad groups and asset groups cannot be removed (it cannot be undone). Pause them instead.
- Allowed operation types: ${MUTATE_OPERATION_TYPES.join(", ")}.

Performance Max: a campaign needs, in one call, a campaignBudgetOperation (not shared), a campaignOperation with advertisingChannelType PERFORMANCE_MAX, a bidding strategy (maximizeConversions or maximizeConversionValue) and containsEuPoliticalAdvertising, and at least one assetGroupOperation with finalUrls. Brand guidelines are on by default for a new campaign, which then needs a business name and a square logo linked with campaignAssetOperation (fieldType BUSINESS_NAME and LOGO); set brandGuidelinesEnabled: false to link them on the asset group instead. A retail campaign fed by Merchant Center sets shoppingSetting.merchantId and adds an assetGroupListingGroupFilterOperation; otherwise the asset group needs its text and image assets (assetOperation + assetGroupAssetOperation) in the same call. Read https://developers.google.com/google-ads/api/docs/performance-max/overview for the exact requirements, look at an existing campaign with search first, and let validate_only tell you what is missing.

Image and video assets must already exist in the account, or be created with assetOperation and base64 data; this server cannot fetch a file from a URL.`;

export interface GoogleAdsServerOptions {
  /** Overrides GOOGLE_ADS_WRITE_TOOLS. "off" registers no write tool. */
  writeLevel?: WriteLevel;
}

/**
 * A new server around a client. The chassis builds the client once (its JWT
 * caches the access token) and calls this per request.
 */
export function createGoogleAdsServer(
  client: GoogleAdsClient = createGoogleAdsClient(),
  options: GoogleAdsServerOptions = {},
): McpServer {
  const level = options.writeLevel ?? writeLevel(process.env.GOOGLE_ADS_WRITE_TOOLS);
  const server = new McpServer(
    { name: "google-ads-mcp", version: VERSION },
    {
      instructions: level === "off"
        ? INSTRUCTIONS
        : INSTRUCTIONS.replace("(read-only)", "(read, and write through mutate)") +
          " Before any change, validate it with mutate (validate_only: true) and tell the user exactly what will change.",
    },
  );
  const readOnly = { readOnlyHint: true, openWorldHint: true };

  server.registerTool(
    "list_accessible_customers",
    {
      title: "List accessible customers",
      description:
        "Returns ids of customers directly accessible by the account authenticating the call.\n\n" +
        "Use this tool first to discover available customer IDs if the user hasn't provided one. " +
        "Most other tools require a valid customer ID as input. Accounts under a manager account are " +
        "not listed here: query the customer_client resource on the manager account to see them.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      try {
        return jsonResult(await client.listAccessibleCustomers());
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search Google Ads",
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        customer_id: customerId,
        fields: z.array(z.string()).min(1).describe("The fields to fetch, e.g. ['campaign.name', 'metrics.clicks']."),
        resource: z.string().describe("The resource to return fields from, e.g. 'campaign'."),
        conditions: z.array(z.string()).optional()
          .describe("Conditions to filter the data, combined using AND, e.g. \"segments.date BETWEEN '2026-01-01' AND '2026-01-31'\"."),
        orderings: z.array(z.string()).optional().describe("How the data is ordered, e.g. 'metrics.clicks DESC'."),
        limit: z.number().int().positive().optional().describe("The maximum number of rows to return."),
        login_customer_id: loginCustomerId,
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const query = buildQuery(args);
        const { rows, truncated } = await client.search(
          cleanCustomerId(args.customer_id),
          query,
          args.login_customer_id == null ? undefined : cleanCustomerId(args.login_customer_id),
        );
        const flat = flattenRows(rows, args.fields);
        return jsonResult(truncated ? { rows: flat, row_count: flat.length, truncated: true } : { rows: flat, row_count: flat.length });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_resource_metadata",
    {
      title: "Get resource metadata",
      description: METADATA_DESCRIPTION,
      inputSchema: {
        resource_name: z.string().describe("The name of the Google Ads resource (e.g. 'campaign', 'ad_group')."),
      },
      annotations: readOnly,
    },
    async ({ resource_name }) => {
      try {
        const queries = metadataQueries(resource_name);
        const [attributes, metricsAndSegments] = await Promise.all([
          client.searchFields(queries.attributes),
          client.searchFields(queries.metricsAndSegments),
        ]);
        return jsonResult(collectMetadata(resource_name, [...attributes, ...metricsAndSegments]));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  if (level !== "off") {
    server.registerTool(
      "mutate",
      {
        title: "Change Google Ads",
        description: mutateDescription(level),
        inputSchema: {
          customer_id: customerId,
          operations: z.array(z.record(z.string(), z.any())).min(1)
            .describe("MutateOperation objects, REST camelCase form, one operation type per object."),
          validate_only: z.boolean().optional()
            .describe("Default true: check the request without changing anything. Pass false to apply."),
          login_customer_id: loginCustomerId,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          const operations = checkOperations(args.operations, level);
          const validateOnly = args.validate_only !== false;
          const response = await client.mutate(cleanCustomerId(args.customer_id), operations, {
            validateOnly,
            loginCustomerId: args.login_customer_id == null ? undefined : cleanCustomerId(args.login_customer_id),
          });
          return jsonResult(validateOnly
            ? {
                validated: true,
                applied: false,
                operations: operations.length,
                next: "Nothing was changed. Tell the user what these operations will do; call again with validate_only: false once they agree.",
              }
            : { applied: true, results: summarizeMutateResponse(operations, response) });
        } catch (e) {
          return errorResult(e);
        }
      },
    );
  }

  return server;
}
