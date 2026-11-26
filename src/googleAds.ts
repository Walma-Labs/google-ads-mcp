// Google Ads client: service-account auth + the three REST calls the tools
// need. Deliberately NOT the google-ads-api gRPC packages: three endpoints
// don't justify them, and a thin client keeps the request function injectable
// for tests and for the Walma MCP chassis.
//
// Auth (JSON wins when both are set):
//   GOOGLE_ADS_SERVICE_ACCOUNT_JSON  the key as inline JSON (Key Vault / chassis path)
//   GOOGLE_ADS_SERVICE_ACCOUNT_FILE  path to the key file (local / CLI path)
//   GOOGLE_ADS_DEVELOPER_TOKEN       required by every Google Ads API call
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID     optional manager account to act through
//   GOOGLE_ADS_LOCK_LOGIN_CUSTOMER_ID  optional: "1" fences the server to that manager (see below)
//   GOOGLE_ADS_API_VERSION           optional, default below
//
//   GOOGLE_ADS_WRITE_TOOLS           optional: "draft" (or "1") or "live". Off when unset.
//
// Unless GOOGLE_ADS_WRITE_TOOLS is set, the server registers only tools that
// search and list, so it cannot change anything in Google Ads whatever role
// the service account was given. See logic.ts for what the two levels allow.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { JWT } from "google-auth-library";
import { cleanCustomerId } from "./logic.js";

export const SCOPES = ["https://www.googleapis.com/auth/adwords"];

/** The version Google's own google-ads-mcp targets. Versions sunset about a year after release. */
export const DEFAULT_API_VERSION = "v25";

/** GoogleAdsService.Search returns fixed pages of 10 000 rows; one page is the most a tool call returns. */
export const MAX_ROWS = 10_000;

/** Minimal authorized-request signature: what tests and the chassis inject. */
export type RequestFn = (opts: {
  url: string;
  method: "GET" | "POST";
  data?: unknown;
  headers?: Record<string, string>;
}) => Promise<{ data: any }>;

export interface SearchResult {
  /** Rows as the REST API returns them: nested objects with camelCase keys. */
  rows: any[];
  /** True when the query matched more rows than one page holds. */
  truncated: boolean;
}

export interface GoogleAdsClient {
  /** Customer ids the service account can reach directly. */
  listAccessibleCustomers(): Promise<string[]>;
  search(customerId: string, query: string, loginCustomerId?: string): Promise<SearchResult>;
  /** GoogleAdsFieldService.SearchGoogleAdsFields, every page. */
  searchFields(query: string): Promise<any[]>;
  /**
   * GoogleAdsService.Mutate: all operations succeed or none are applied. The
   * caller is responsible for the write gate (logic.checkOperations); the
   * server only registers a tool that reaches this when writing is enabled.
   */
  mutate(
    customerId: string,
    operations: Record<string, any>[],
    options?: { validateOnly?: boolean; loginCustomerId?: string },
  ): Promise<any>;
}

export interface GoogleAdsClientOptions {
  developerToken?: string;
  loginCustomerId?: string;
  /**
   * Fence the client to `loginCustomerId` and the accounts under it. Every call
   * then goes through that manager, a caller cannot name another one, and only
   * that manager is listed as accessible. Google refuses a customer that is not
   * under the login manager, so whatever else the service account was added to
   * stays out of reach. Defaults to GOOGLE_ADS_LOCK_LOGIN_CUSTOMER_ID.
   */
  lockLoginCustomer?: boolean;
  apiVersion?: string;
}

function loadCredentials(): { client_email: string; private_key: string } {
  const inline = process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch {
      throw new Error("GOOGLE_ADS_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
  }
  let file = process.env.GOOGLE_ADS_SERVICE_ACCOUNT_FILE;
  if (!file) {
    throw new Error("GOOGLE_ADS_SERVICE_ACCOUNT_FILE is not set (or set GOOGLE_ADS_SERVICE_ACCOUNT_JSON)");
  }
  if (file.startsWith("~")) file = file.replace(/^~/, homedir());
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Service account key not found: ${file}`);
  }
  return JSON.parse(raw);
}

/** Lazily constructed so importing the package never demands credentials. */
export function createDefaultRequestFn(): RequestFn {
  let jwt: JWT | null = null;
  return async (opts) => {
    if (!jwt) {
      const creds = loadCredentials();
      jwt = new JWT({ email: creds.client_email, key: creds.private_key, scopes: SCOPES });
    }
    return jwt.request({ url: opts.url, method: opts.method, data: opts.data, headers: opts.headers });
  };
}

export function createGoogleAdsClient(
  request: RequestFn = createDefaultRequestFn(),
  options: GoogleAdsClientOptions = {},
): GoogleAdsClient {
  const version = options.apiVersion ?? process.env.GOOGLE_ADS_API_VERSION ?? DEFAULT_API_VERSION;
  const base = `https://googleads.googleapis.com/${version}`;

  // Read at call time, not at construction: the chassis puts secrets in the
  // environment before the first request, and a missing token should be a clear
  // error on the tool call rather than a crash at import.
  const configuredLogin = (): string =>
    cleanCustomerId(options.loginCustomerId ?? process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "");
  const locked = (): boolean =>
    options.lockLoginCustomer ?? /^(1|true)$/i.test((process.env.GOOGLE_ADS_LOCK_LOGIN_CUSTOMER_ID ?? "").trim());

  const headers = (loginCustomerId?: string): Record<string, string> => {
    const token = options.developerToken ?? process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    if (!token) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is not set");
    const configured = configuredLogin();
    if (locked()) {
      // Fail closed: a lock without a manager would fence nothing.
      if (!configured) throw new Error("GOOGLE_ADS_LOCK_LOGIN_CUSTOMER_ID is set but GOOGLE_ADS_LOGIN_CUSTOMER_ID is not");
      const asked = loginCustomerId ? cleanCustomerId(loginCustomerId) : "";
      if (asked && asked !== configured) {
        throw new Error(`This server only works through manager account ${configured}. Leave login_customer_id out.`);
      }
      return { "developer-token": token, "login-customer-id": configured };
    }
    const login = loginCustomerId ? cleanCustomerId(loginCustomerId) : configured;
    return login ? { "developer-token": token, "login-customer-id": login } : { "developer-token": token };
  };

  return {
    async listAccessibleCustomers() {
      const { data } = await request({
        url: `${base}/customers:listAccessibleCustomers`, method: "GET", headers: headers(),
      });
      const ids = ((data?.resourceNames ?? []) as string[]).map(n => n.replace(/^customers\//, ""));
      // Locked: the service account may reach other accounts directly; they are not this server's.
      return locked() ? ids.filter(id => id === configuredLogin()) : ids;
    },

    async search(customerId, query, loginCustomerId) {
      const { data } = await request({
        url: `${base}/customers/${cleanCustomerId(customerId)}/googleAds:search`,
        method: "POST",
        data: { query },
        headers: headers(loginCustomerId),
      });
      const rows = (data?.results ?? []) as any[];
      return { rows: rows.slice(0, MAX_ROWS), truncated: Boolean(data?.nextPageToken) || rows.length > MAX_ROWS };
    },

    async mutate(customerId, operations, opts = {}) {
      const { data } = await request({
        url: `${base}/customers/${cleanCustomerId(customerId)}/googleAds:mutate`,
        method: "POST",
        data: { mutateOperations: operations, validateOnly: Boolean(opts.validateOnly), partialFailure: false },
        headers: headers(opts.loginCustomerId),
      });
      return data ?? {};
    },

    async searchFields(query) {
      const out: any[] = [];
      let pageToken: string | undefined;
      do {
        const { data } = await request({
          url: `${base}/googleAdsFields:search`,
          method: "POST",
          data: pageToken ? { query, pageToken } : { query },
          headers: headers(),
        });
        out.push(...(data?.results ?? []));
        pageToken = data?.nextPageToken || undefined;
      } while (pageToken);
      return out;
    },
  };
}
