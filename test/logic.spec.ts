import { describe, it, expect } from "vitest";
import {
  buildQuery, checkOperations, cleanCustomerId, collectMetadata, flattenRows, formatGoogleAdsError,
  metadataQueries, summarizeMutateResponse, writeLevel,
} from "../src/logic.js";

describe("cleanCustomerId", () => {
  it("drops hyphens and anything else that is not a digit", () => {
    expect(cleanCustomerId("123-456-7890")).toBe("1234567890");
    expect(cleanCustomerId(1234567890)).toBe("1234567890");
    expect(cleanCustomerId("customers/123")).toBe("123");
  });
});

describe("buildQuery", () => {
  it("assembles the same query as Google's server", () => {
    expect(buildQuery({
      fields: ["campaign.id", "metrics.clicks"],
      resource: "campaign",
      conditions: ["segments.date BETWEEN '2026-01-01' AND '2026-01-31'", "metrics.clicks > 0"],
      orderings: ["metrics.clicks DESC"],
      limit: 50,
    })).toBe(
      "SELECT campaign.id,metrics.clicks FROM campaign"
      + " WHERE segments.date BETWEEN '2026-01-01' AND '2026-01-31' AND metrics.clicks > 0"
      + " ORDER BY metrics.clicks DESC LIMIT 50 PARAMETERS omit_unselected_resource_names=true",
    );
  });

  it("leaves out the clauses that were not given", () => {
    expect(buildQuery({ fields: ["customer.id"], resource: "customer", conditions: [" "], orderings: [] }))
      .toBe("SELECT customer.id FROM customer PARAMETERS omit_unselected_resource_names=true");
  });

  it("refuses partial fields, wildcards and anything that is not a resource name", () => {
    expect(() => buildQuery({ fields: ["id"], resource: "campaign" })).toThrow(/whole name/);
    expect(() => buildQuery({ fields: ["campaign.*"], resource: "campaign" })).toThrow(/Not a field name/);
    expect(() => buildQuery({ fields: ["campaign.id"], resource: "campaign WHERE 1=1" })).toThrow(/resource name/);
    expect(() => buildQuery({ fields: [], resource: "campaign" })).toThrow(/empty/);
    expect(() => buildQuery({ fields: ["campaign.id"], resource: "campaign", limit: 0 })).toThrow(/limit/);
  });
});

describe("flattenRows", () => {
  it("keys each row by the selected field names", () => {
    const rows = [{
      campaign: { id: "1", name: "Brand", networkSettings: { targetSearchNetwork: true } },
      metrics: { costMicros: "1500000", clicks: "12" },
      segments: { date: "2026-01-05" },
    }];
    expect(flattenRows(rows, [
      "campaign.id", "campaign.name", "campaign.network_settings.target_search_network",
      "metrics.cost_micros", "metrics.clicks", "segments.date",
    ])).toEqual([{
      "campaign.id": "1",
      "campaign.name": "Brand",
      "campaign.network_settings.target_search_network": true,
      "metrics.cost_micros": "1500000",
      "metrics.clicks": "12",
      "segments.date": "2026-01-05",
    }]);
  });

  it("gives null for a field the API left out", () => {
    expect(flattenRows([{ campaign: { id: "1" } }], ["campaign.id", "metrics.conversions"]))
      .toEqual([{ "campaign.id": "1", "metrics.conversions": null }]);
  });
});

describe("resource metadata", () => {
  it("asks for the resource's attributes and for what is selectable with it", () => {
    const q = metadataQueries("ad_group");
    expect(q.attributes).toBe("SELECT name, selectable, filterable, sortable WHERE name LIKE 'ad_group.%' AND category = 'ATTRIBUTE'");
    expect(q.metricsAndSegments).toBe("SELECT name, selectable, filterable, sortable WHERE selectable_with CONTAINS ANY('ad_group')");
  });

  it("refuses a name that could break out of the quoted string", () => {
    expect(() => metadataQueries("campaign' OR name LIKE '%")).toThrow(/resource name/);
  });

  it("sorts and de-duplicates the three lists", () => {
    expect(collectMetadata("campaign", [
      { name: "metrics.clicks", selectable: true, filterable: true, sortable: true },
      { name: "campaign.id", selectable: true, filterable: true, sortable: true },
      { name: "campaign.id", selectable: true, filterable: true, sortable: true },
      { name: "campaign.labels", selectable: true, filterable: true, sortable: false },
      { name: "segments.keyword.info.text", selectable: true, filterable: false },
    ])).toEqual({
      resource: "campaign",
      selectable: ["campaign.id", "campaign.labels", "metrics.clicks", "segments.keyword.info.text"],
      filterable: ["campaign.id", "campaign.labels", "metrics.clicks"],
      sortable: ["campaign.id", "metrics.clicks"],
    });
  });
});

describe("formatGoogleAdsError", () => {
  it("lifts the API's own message and request id out of the failure", () => {
    const e = { response: { data: { error: {
      code: 400, message: "Request contains an invalid argument.",
      details: [{ requestId: "abc123", errors: [{ message: "Unrecognized field in the query: 'campaign.nam'." }] }],
    } } } };
    expect(formatGoogleAdsError(e)).toBe("Request ID: abc123\nGoogle Ads API Error: Unrecognized field in the query: 'campaign.nam'.");
  });

  it("falls back to the HTTP message, then to the thrown error", () => {
    expect(formatGoogleAdsError({ response: { data: { error: { message: "The caller does not have permission" } } } }))
      .toBe("Google Ads API Error: The caller does not have permission");
    expect(formatGoogleAdsError(new Error("GOOGLE_ADS_DEVELOPER_TOKEN is not set"))).toBe("GOOGLE_ADS_DEVELOPER_TOKEN is not set");
  });
});

describe("writeLevel", () => {
  it("is off unless switched on, and live only when asked for by name", () => {
    expect(writeLevel(undefined)).toBe("off");
    expect(writeLevel("")).toBe("off");
    expect(writeLevel("0")).toBe("off");
    expect(writeLevel("yes")).toBe("off");
    expect(writeLevel("1")).toBe("draft");
    expect(writeLevel("draft")).toBe("draft");
    expect(writeLevel(" LIVE ")).toBe("live");
  });
});

describe("checkOperations", () => {
  const budget = { campaignBudgetOperation: { create: { resourceName: "customers/1/campaignBudgets/-1", name: "B", amountMicros: "50000000", explicitlyShared: false } } };
  const campaign = (status?: string) => ({ campaignOperation: { create: { name: "PMax", ...(status ? { status } : {}), advertisingChannelType: "PERFORMANCE_MAX", campaignBudget: "customers/1/campaignBudgets/-1" } } });

  it("lets a paused Performance Max build through", () => {
    const ops = [budget, campaign("PAUSED"), { assetGroupOperation: { create: { name: "AG", campaign: "customers/1/campaigns/-2", finalUrls: ["https://example.com"] } } }];
    expect(checkOperations(ops, "draft")).toBe(ops);
  });

  it("refuses everything when writing is off", () => {
    expect(() => checkOperations([budget], "off")).toThrow(/not enabled/);
  });

  it("refuses a campaign that is not created paused, at either level", () => {
    expect(() => checkOperations([campaign("ENABLED")], "draft")).toThrow(/status must be "PAUSED"/);
    expect(() => checkOperations([campaign()], "draft")).toThrow(/status must be "PAUSED"/);
    expect(() => checkOperations([campaign("ENABLED")], "live")).toThrow(/status must be "PAUSED"/);
  });

  it("lets only the live level enable a campaign or change a budget", () => {
    const enable = { campaignOperation: { update: { resourceName: "customers/1/campaigns/5", status: "ENABLED" }, updateMask: "status" } };
    const raise = { campaignBudgetOperation: { update: { resourceName: "customers/1/campaignBudgets/5", amountMicros: "90000000" }, updateMask: "amount_micros" } };
    expect(() => checkOperations([enable], "draft")).toThrow(/enabling a campaign starts spending/);
    expect(() => checkOperations([raise], "draft")).toThrow(/changing an existing budget/);
    expect(checkOperations([enable, raise], "live")).toHaveLength(2);
    const pause = { campaignOperation: { update: { resourceName: "customers/1/campaigns/5", status: "PAUSED" }, updateMask: "status" } };
    expect(checkOperations([pause], "draft")).toHaveLength(1);
  });

  it("refuses removing what cannot be restored, but allows removing a criterion", () => {
    for (const type of ["campaignOperation", "campaignBudgetOperation", "adGroupOperation", "assetGroupOperation"]) {
      expect(() => checkOperations([{ [type]: { remove: "customers/1/x/1" } }], "live")).toThrow(/removing is not allowed/);
    }
    expect(checkOperations([{ campaignCriterionOperation: { remove: "customers/1/campaignCriteria/1~2" } }], "draft")).toHaveLength(1);
  });

  it("refuses account-level operation types and malformed operations", () => {
    expect(() => checkOperations([{ customerUserAccessOperation: { update: {} } }], "live")).toThrow(/customerUserAccessOperation is not allowed/);
    expect(() => checkOperations([{ billingSetupOperation: { create: {} } }], "live")).toThrow(/not allowed/);
    expect(() => checkOperations([{ campaignOperation: {} }], "draft")).toThrow(/exactly one of create, update or remove/);
    expect(() => checkOperations([{ a: 1, b: 2 }], "draft")).toThrow(/exactly one key/);
    expect(() => checkOperations([], "draft")).toThrow(/empty/);
    expect(() => checkOperations("x", "draft")).toThrow(/empty/);
  });

  it("names every problem in the batch at once", () => {
    const err = (() => { try { checkOperations([campaign("ENABLED"), { campaignOperation: { remove: "customers/1/campaigns/1" } }], "draft"); } catch (e) { return (e as Error).message; } })();
    expect(err).toMatch(/operations\[0\]/);
    expect(err).toMatch(/operations\[1\]/);
    expect(err).toMatch(/^The request was not sent/);
  });
});

describe("summarizeMutateResponse", () => {
  it("pairs each operation with the resource it produced", () => {
    const ops = [
      { campaignBudgetOperation: { create: {} } },
      { campaignOperation: { update: {}, updateMask: "name" } },
      { campaignCriterionOperation: { remove: "customers/1/campaignCriteria/1~2" } },
    ];
    expect(summarizeMutateResponse(ops, { mutateOperationResponses: [
      { campaignBudgetResult: { resourceName: "customers/1/campaignBudgets/9" } },
      { campaignResult: { resourceName: "customers/1/campaigns/5" } },
      { campaignCriterionResult: { resourceName: "customers/1/campaignCriteria/1~2" } },
    ] })).toEqual([
      { operation: "campaignBudget", action: "create", resource_name: "customers/1/campaignBudgets/9" },
      { operation: "campaign", action: "update", resource_name: "customers/1/campaigns/5" },
      { operation: "campaignCriterion", action: "remove", resource_name: "customers/1/campaignCriteria/1~2" },
    ]);
  });
});

describe("formatGoogleAdsError location", () => {
  it("says where in the request the problem is", () => {
    const e = { response: { data: { error: { details: [{ errors: [{
      message: "The required field was not present.",
      location: { fieldPathElements: [{ fieldName: "mutate_operations", index: 1 }, { fieldName: "campaign_operation" }, { fieldName: "create" }, { fieldName: "name" }] },
    }] }] } } } };
    expect(formatGoogleAdsError(e)).toBe("Google Ads API Error: The required field was not present. (at mutate_operations[1].campaign_operation.create.name)");
  });
});
