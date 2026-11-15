#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../src/config.js";
import { startHttpServer } from "../src/http.js";
import { runStdioServer } from "../src/server.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`farmos-mcp — MCP server for a farmOS 4.x instance

stdio (Cursor, Claude Desktop):
  farmos-mcp

Streamable HTTP (ChatGPT, Gemini, remote clients):
  farmos-mcp --http

Environment:
  FARMOS_URL                 farmOS base URL (https)
  FARMOS_CLIENT_ID           OAuth client id (default farm)
  FARMOS_CLIENT_SECRET       client credentials secret
  FARMOS_USERNAME            password grant username (optional)
  FARMOS_PASSWORD            password grant password (optional)
  FARMOS_SCOPE               OAuth scope (default farm_worker)
  FARMOS_ALLOW_WRITES        true to enable create/update tools
  FARMOS_ALLOW_DELETE        reserved; no delete tool is exposed
  FARMOS_ENV_FILE            env file loaded when a variable is unset
  FARMOS_MCP_HOST            HTTP bind host (default 127.0.0.1)
  FARMOS_MCP_PORT            HTTP port (default 8787)
  FARMOS_MCP_HTTP_TOKEN      bearer required off loopback, and for ChatGPT login
  FARMOS_MCP_PUBLIC_URL      public https origin advertised to OAuth clients
  FARMOS_MCP_STATE_DIR       where refresh tokens are stored
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(dir, "..", "..", "package.json"), "utf8")) as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

const envFile = process.env.FARMOS_ENV_FILE;
if (envFile) loadEnvFile(envFile);

if (args.includes("--http")) {
  const host = process.env.FARMOS_MCP_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.FARMOS_MCP_PORT || 8787);
  const stateDir = process.env.FARMOS_MCP_STATE_DIR?.trim();
  const http = await startHttpServer({
    host,
    port,
    token: process.env.FARMOS_MCP_HTTP_TOKEN?.trim() || undefined,
    publicUrl: process.env.FARMOS_MCP_PUBLIC_URL?.trim() || undefined,
    extraRedirects: (process.env.FARMOS_MCP_OAUTH_REDIRECTS || "").split(",").map((item) => item.trim()).filter(Boolean),
    stateFile: stateDir ? join(stateDir, "refresh-tokens.json") : undefined,
  });
  console.error(`farmos-mcp HTTP listening on ${http.url}`);
} else if (process.stdin.isTTY) {
  console.error("farmos-mcp speaks MCP over stdio. Use --http for a remote endpoint, or --help.");
  process.exit(0);
} else {
  await runStdioServer();
}
