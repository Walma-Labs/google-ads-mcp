// Pure logic, no I/O: building the GAQL query from the tool's arguments,
// flattening the REST rows, and turning an API failure into a message the
// model can act on. Everything here is unit-tested without network.

const RESOURCE_RE = /^[a-z][a-z0-9_]*$/;
const FIELD_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** "123-456-7890" → "1234567890". Anything that is not a digit is dropped. */
export function cleanCustomerId(customerId: string | number): string {
  return String(customerId).replace(/\D/g, "");
}

export function assertResourceName(resource: string): string {
  if (!RESOURCE_RE.test(resource)) {
    throw new Error(`Not a Google Ads resource name: "${resource}". Use a name from the list, e.g. "campaign".`);
  }
  return resource;
}

export interface SearchArgs {
  fields: string[];
  resource: string;
  conditions?: string[];
  orderings?: string[];
  limit?: number;
}

/**
 * The GAQL query for a search call. Same assembly as Google's server: fields
 * joined by commas, conditions joined by AND, and unselected resource names
 * left out of the rows.
 */
export function buildQuery(args: SearchArgs): string {
  if (!args.fields.length) throw new Error("fields is empty: name at least one field to select");
  for (const f of args.fields) {
    if (!FIELD_RE.test(f)) {
      throw new Error(`Not a field name: "${f}". Use the whole name, e.g. "campaign.id", not "id" and no wildcards.`);
    }
  }
  const parts = [`SELECT ${args.fields.join(",")} FROM ${assertResourceName(args.resource)}`];
  const conditions = (args.conditions ?? []).map(c => c.trim()).filter(Boolean);
  const orderings = (args.orderings ?? []).map(o => o.trim()).filter(Boolean);
  if (conditions.length) parts.push(` WHERE ${conditions.join(" AND ")}`);
  if (orderings.length) parts.push(` ORDER BY ${orderings.join(",")}`);
  if (args.limit != null) {
    if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error("limit must be a whole number above 0");
    parts.push(` LIMIT ${args.limit}`);
  }
  parts.push(" PARAMETERS omit_unselected_resource_names=true");
  return parts.join("");
}

const camel = (segment: string) => segment.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * One flat object per row, keyed by the field names the caller selected
 * ("campaign.name", "metrics.cost_micros"). The REST API answers with nested
 * camelCase objects; the selected names are what the model asked for and what
 * it will filter and sort on next, so those are the keys it gets back. A field
 * the API left out (a zero or unset value) comes back as null.
 */
export function flattenRows(rows: any[], fields: string[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      let value: any = row;
      for (const segment of field.split(".")) {
        value = value == null ? undefined : value[camel(segment)];
      }
      out[field] = value === undefined ? null : value;
    }
    return out;
  });
}

export interface FieldMetadata {
  resource: string;
  selectable: string[];
  filterable: string[];
  sortable: string[];
}

/** The two field-service queries behind get_resource_metadata. */
export function metadataQueries(resource: string): { attributes: string; metricsAndSegments: string } {
  const name = assertResourceName(resource);
  return {
    attributes: `SELECT name, selectable, filterable, sortable WHERE name LIKE '${name}.%' AND category = 'ATTRIBUTE'`,
    metricsAndSegments: `SELECT name, selectable, filterable, sortable WHERE selectable_with CONTAINS ANY('${name}')`,
  };
}

export function collectMetadata(resource: string, fields: any[]): FieldMetadata {
  const pick = (flag: "selectable" | "filterable" | "sortable") =>
    [...new Set(fields.filter(f => f?.[flag] && typeof f.name === "string").map(f => f.name as string))].sort();
  return { resource, selectable: pick("selectable"), filterable: pick("filterable"), sortable: pick("sortable") };
}

/**
 * The message for a failed API call. Google Ads puts the useful part in
 * error.details[].errors[].message ("Unrecognized field in the query: …") and
 * the request id support asks for beside it; the HTTP message alone is just
 * "Request contains an invalid argument".
 */
export function formatGoogleAdsError(e: unknown): string {
  const body = (e as any)?.response?.data;
  const error = Array.isArray(body) ? body[0]?.error : body?.error;
  if (!error) return e instanceof Error ? e.message : String(e);
  const lines: string[] = [];
  let requestId: string | undefined;
  for (const detail of error.details ?? []) {
    requestId ??= detail?.requestId;
    for (const item of detail?.errors ?? []) {
      if (!item?.message) continue;
      // Where in the request the problem is: "mutate_operations[2].campaign_operation.create.name".
      const path = (item.location?.fieldPathElements ?? [])
        .map((p: any) => (p.index == null ? p.fieldName : `${p.fieldName}[${p.index}]`))
        .join(".");
      lines.push(`Google Ads API Error: ${item.message}${path ? ` (at ${path})` : ""}`);
    }
  }
  if (!lines.length && error.message) lines.push(`Google Ads API Error: ${error.message}`);
  if (requestId) lines.unshift(`Request ID: ${requestId}`);
  return lines.join("\n") || "Google Ads API request failed";
}

// ─── Writing ────────────────────────────────────────────────────────────────
// Off unless the environment turns it on. Two levels, because "may edit" and
// "may start spending" are different decisions:
//   draft  build and edit: everything new is created PAUSED, and nothing here
//          can enable a campaign or change an existing budget.
//   live   also enable campaigns and change budgets.
// The checks below run on every mutate call, before anything is sent.

export type WriteLevel = "off" | "draft" | "live";

export function writeLevel(raw: string | undefined): WriteLevel {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "live") return "live";
  if (v === "1" || v === "true" || v === "draft") return "draft";
  return "off";
}

/**
 * What a mutate call may touch: the building blocks of a campaign. Anything
 * about the account itself (users, billing, account budgets, conversion
 * settings, links to other products) is not on the list and is refused.
 */
export const MUTATE_OPERATION_TYPES: readonly string[] = [
  "campaignBudgetOperation",
  "campaignOperation",
  "campaignCriterionOperation",
  "campaignAssetOperation",
  "campaignAssetSetOperation",
  "campaignLabelOperation",
  "assetOperation",
  "assetSetOperation",
  "assetSetAssetOperation",
  "assetGroupOperation",
  "assetGroupAssetOperation",
  "assetGroupSignalOperation",
  "assetGroupListingGroupFilterOperation",
  "adGroupOperation",
  "adGroupAdOperation",
  "adGroupCriterionOperation",
  "adGroupAssetOperation",
  "adGroupLabelOperation",
  "adGroupAdLabelOperation",
  "audienceOperation",
  "labelOperation",
];

/** A removed campaign, budget, ad group or asset group cannot be brought back. Pause instead. */
const NO_REMOVE: readonly string[] = [
  "campaignOperation", "campaignBudgetOperation", "adGroupOperation", "assetGroupOperation",
];

export const MAX_MUTATE_OPERATIONS = 500;

/**
 * Refuses a batch of mutate operations that breaks a rule, naming every
 * problem at once so the caller can fix the batch in one go.
 */
export function checkOperations(operations: unknown, level: WriteLevel): Record<string, any>[] {
  if (level === "off") throw new Error("Writing is not enabled on this server.");
  if (!Array.isArray(operations) || !operations.length) throw new Error("operations is empty: give at least one operation");
  if (operations.length > MAX_MUTATE_OPERATIONS) {
    throw new Error(`Too many operations (${operations.length}); at most ${MAX_MUTATE_OPERATIONS} per call.`);
  }
  const problems: string[] = [];
  operations.forEach((op, i) => {
    const at = `operations[${i}]`;
    const keys = op && typeof op === "object" && !Array.isArray(op) ? Object.keys(op) : [];
    if (keys.length !== 1) {
      problems.push(`${at}: must be an object with exactly one key, e.g. { "campaignOperation": { "create": { … } } }`);
      return;
    }
    const type = keys[0]!;
    if (!MUTATE_OPERATION_TYPES.includes(type)) {
      problems.push(`${at}: ${type} is not allowed here. Allowed: ${MUTATE_OPERATION_TYPES.join(", ")}`);
      return;
    }
    const body = (op as any)[type] ?? {};
    const actions = ["create", "update", "remove"].filter(a => body[a] != null);
    if (actions.length !== 1) {
      problems.push(`${at}.${type}: needs exactly one of create, update or remove`);
      return;
    }
    const action = actions[0]!;
    if (action === "remove" && NO_REMOVE.includes(type)) {
      problems.push(`${at}.${type}: removing is not allowed (it cannot be undone). Set its status to PAUSED instead.`);
    }
    if (type === "campaignOperation" && action === "create" && body.create.status !== "PAUSED") {
      problems.push(`${at}.campaignOperation.create: status must be "PAUSED". A new campaign is never created running.`);
    }
    if (type === "campaignOperation" && action === "update" && body.update.status === "ENABLED" && level !== "live") {
      problems.push(`${at}.campaignOperation.update: enabling a campaign starts spending and is not allowed on this server. Someone enables it in Google Ads.`);
    }
    if (type === "campaignBudgetOperation" && action === "update" && level !== "live") {
      problems.push(`${at}.campaignBudgetOperation.update: changing an existing budget is not allowed on this server. Create a new budget for a new campaign, or change it in Google Ads.`);
    }
  });
  if (problems.length) throw new Error(`The request was not sent:\n- ${problems.join("\n- ")}`);
  return operations as Record<string, any>[];
}

/** One line per operation: what was created, changed or removed. */
export function summarizeMutateResponse(operations: Record<string, any>[], response: any): Record<string, unknown>[] {
  const results = (response?.mutateOperationResponses ?? []) as any[];
  return operations.map((op, i) => {
    const type = Object.keys(op)[0]!;
    const action = ["create", "update", "remove"].find(a => op[type]?.[a] != null)!;
    const result = results[i] ? (Object.values(results[i])[0] as any) : undefined;
    return { operation: type.replace(/Operation$/, ""), action, resource_name: result?.resourceName ?? null };
  });
}
