#!/usr/bin/env node
// stdio entrypoint — what `npx github:Walma-Labs/google-ads-mcp` runs, for Claude Code,
// Claude Desktop (local dev servers), Cursor and any stdio MCP client.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGoogleAdsServer } from "./server.js";

const server = createGoogleAdsServer();
await server.connect(new StdioServerTransport());
