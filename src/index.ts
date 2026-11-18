// Public package surface: the factory (what the Walma MCP chassis imports),
// the thin Google Ads client pieces, and the pure logic for anyone who wants it.

export { createGoogleAdsServer, INSTRUCTIONS, VERSION, type GoogleAdsServerOptions } from "./server.js";
export {
  createGoogleAdsClient, createDefaultRequestFn, SCOPES, DEFAULT_API_VERSION, MAX_ROWS,
  type GoogleAdsClient, type GoogleAdsClientOptions, type RequestFn, type SearchResult,
} from "./googleAds.js";
export { GAQL_RESOURCES } from "./resources.js";
export * as logic from "./logic.js";
