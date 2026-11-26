# google-ads-mcp — Google Ads MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude, Cursor, Claude Code and any other MCP client access to Google Ads: campaigns, ad groups, keywords, search terms, budgets, conversions and anything else the Google Ads Query Language (GAQL) can select. It is read-only by default and can be allowed to build and edit campaigns.

It is a TypeScript port of the read tools in Google's own [google-ads-mcp](https://github.com/googleads/google-ads-mcp), with the same tool names and arguments, so prompts written for one work on the other. What differs:

- **Read-only unless you switch writing on.** Out of the box the server only has tools that search and list. Writing is one extra tool that exists only when `GOOGLE_ADS_WRITE_TOOLS` is set, with rules about what it may do (see [Writing](#writing)).
- **Service-account auth, no gcloud.** Point it at a key file, or pass the key inline.
- **Streamable HTTP as well as stdio.** It can run centrally. This is how [Walma](https://walma.ai) serves it to whole organisations through its AI gateway.
- **Three runtime dependencies.** It calls the REST API directly instead of using the gRPC client library.

Built and used by [Walma AI](https://walma.ai).

## Tools

| Tool | What it does |
|---|---|
| `list_accessible_customers` | The customer ids the service account can reach directly |
| `get_resource_metadata` | The selectable, filterable and sortable fields of a resource, with its compatible metrics and segments |
| `search` | A GAQL query built from `fields`, `resource`, `conditions`, `orderings` and `limit` |

Rows come back as one object per row, keyed by the field names that were selected:

```json
{ "campaign.name": "Brand", "metrics.clicks": "120", "metrics.cost_micros": "45000000" }
```

Cost and bid fields ending in `_micros` are millionths of the account currency. A call returns at most 10 000 rows and says `"truncated": true` when there were more.

## Writing

Set `GOOGLE_ADS_WRITE_TOOLS` and the server gains a fourth tool, `mutate`, which sends a batch of [mutate operations](https://developers.google.com/google-ads/api/rest/reference/rest/latest/customers.googleAds/mutate) that succeed together or not at all. The service account then needs **Standard** access in Google Ads instead of read-only.

| Value | The tool may |
|---|---|
| unset | nothing: the tool is not registered |
| `draft` (or `1`) | create and edit campaigns, budgets, asset groups, assets, ad groups, ads, criteria and labels. Everything new is paused, and it cannot enable a campaign or change an existing budget |
| `live` | all of that, and enable campaigns and change budgets |

Whatever the value:

- **A dry run comes first.** `validate_only` defaults to `true`: Google Ads checks the request and nothing changes. Applying takes a second call with `validate_only: false`.
- **A new campaign must be created `PAUSED`.** Someone turns it on, in Google Ads or (at `live`) by asking for it.
- **Campaigns, budgets, ad groups and asset groups cannot be removed.** That cannot be undone in Google Ads; pause them instead.
- **Only campaign building blocks.** Users, billing, account budgets, conversion settings and links to other products are refused.

These rules are checked in the server before anything is sent, so they hold whatever the model is asked to do. They are not a spending limit: at `draft` an edit to a campaign that is already running (its ads, keywords, bidding targets) takes effect at once. Have your MCP client ask before each `mutate` call.

Every caller writes as the same service account, so Google Ads' change history shows the service account, not the person.

Image and video assets have to exist in the account already, or be sent as base64 in an `assetOperation`. The server does not fetch files from URLs.

## Setup

### 1. Developer token

Every Google Ads API call needs a developer token. It comes from **Tools → API Center** in a Google Ads **manager** account. A new token starts at test access, which only works against test accounts; apply for **Basic access** to read real accounts. Approval can take a few days.

### 2. Service account and key

1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a project.
2. Enable the **Google Ads API**.
3. IAM & Admin → Service accounts → Create. No project roles are needed.
4. Keys → Add key → JSON. Save the file outside any repository, for example `~/.config/gcloud/google-ads-service-account.json`.

### 3. Give the service account access in Google Ads

In the Google Ads account (or in a manager account above it), open **Admin → Access and security → Users** and add the service account's email address (`…@….iam.gserviceaccount.com`). **Read only** is enough for the read tools; writing needs **Standard**.

The server sees exactly the accounts the service account was added to. Use one service account per organisation: an account added for two customers shows both to everyone who can reach the server.

If the service account was added to a manager account rather than to the ad accounts themselves, set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to the manager's customer id.

### 4. Add it to your MCP client

**Claude Code:**

```sh
claude mcp add google-ads --scope user \
  -e GOOGLE_ADS_SERVICE_ACCOUNT_FILE=~/.config/gcloud/google-ads-service-account.json \
  -e GOOGLE_ADS_DEVELOPER_TOKEN=your-developer-token \
  -- npx -y github:Walma-Labs/google-ads-mcp
```

**Claude Desktop, Cursor and others** (`mcpServers` in the client's config):

```json
{
  "mcpServers": {
    "google-ads": {
      "command": "npx",
      "args": ["-y", "github:Walma-Labs/google-ads-mcp"],
      "env": {
        "GOOGLE_ADS_SERVICE_ACCOUNT_FILE": "~/.config/gcloud/google-ads-service-account.json",
        "GOOGLE_ADS_DEVELOPER_TOKEN": "your-developer-token"
      }
    }
  }
}
```

## Configuration

| Variable | |
|---|---|
| `GOOGLE_ADS_SERVICE_ACCOUNT_FILE` | Path to the service-account key file |
| `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` | The key as inline JSON. Wins over the file when both are set |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Required |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Optional manager account. A tool call can also pass `login_customer_id` |
| `GOOGLE_ADS_LOCK_LOGIN_CUSTOMER_ID` | Optional. `1` fences the server to `GOOGLE_ADS_LOGIN_CUSTOMER_ID` and the accounts under it: every call goes through that manager, a tool call cannot name another, and only that manager is listed as accessible. Set it whenever the service account can reach accounts this server should not serve |
| `GOOGLE_ADS_WRITE_TOOLS` | Optional: `draft` or `live`. See [Writing](#writing) |
| `GOOGLE_ADS_API_VERSION` | Optional, default `v25`. Google retires a version about a year after its release |

## Running over HTTP

```sh
npm run build
PORT=8080 npm run start:http
```

`POST /` is the MCP endpoint (streamable HTTP, stateless) and `GET /healthz` answers `ok`. There is **no authentication** in this process: put it behind something that authenticates callers.

## Using it as a library

```ts
import { createGoogleAdsClient, createGoogleAdsServer } from "@walma-labs/google-ads-mcp";

const client = createGoogleAdsClient();            // built once; caches its access token
const server = createGoogleAdsServer(client);      // a fresh McpServer per request
```

## Development

```sh
npm install
npm test
```

The tests drive the real MCP wire against a mocked request function, so they need neither network nor credentials.

When `GOOGLE_ADS_API_VERSION` moves on, refresh `src/resources.ts` from Google's `ads_mcp/gaql_resources.txt`.

## Licence

Apache-2.0. Tool names, argument contracts, tool descriptions and the resource list derive from Google's google-ads-mcp; see `NOTICE`.
