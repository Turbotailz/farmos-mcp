# Connect an assistant

The HTTP server has to be up and the hostname has to resolve. See [homelab.md](homelab.md). The shared secret is `FARMOS_MCP_HTTP_TOKEN` in the homelab env file. Give it to someone only if they should be able to read the farm (and write to it, once writes are turned on).

## Cursor on this machine

Prefer stdio. It does not need the public hostname.

```json
{
  "mcpServers": {
    "farmos": {
      "command": "node",
      "args": ["/absolute/path/to/farmos-mcp/dist/bin/cli.js"],
      "env": { "FARMOS_ENV_FILE": "/absolute/path/to/dunslaw.env" }
    }
  }
}
```

## ChatGPT

1. Plugins → Add custom MCP server.
2. Server URL: `https://farmos-mcp.dunslaw.com.au/mcp`
3. Authentication: OAuth.
4. When the browser opens the farmOS MCP login, paste the shared access token.
5. Ask: “Use the farmOS app. What is the farm name, and which equipment assets exist?”

If ChatGPT reports a redirect URI error, copy the URI from the error into `FARMOS_MCP_OAUTH_REDIRECTS` (comma-separated, exact match) and recreate the container.

## Gemini

Add a custom app with server URL `https://farmos-mcp.dunslaw.com.au/mcp`. Leave Client ID and Client secret empty, then click Next. Gemini registers itself. The redirect host it uses, `oauth-redirect.googleusercontent.com`, is allowed. The login page then asks for the shared access token.

## Claude (remote)

Claude Desktop on the same computer should use the stdio command instead. A remote Claude connector uses the same HTTPS URL and OAuth login. `claude.ai` callbacks are allowed.

## What people can do

With the default env file, the assistant can look up assets, logs, plans, and terms. It cannot create records until `FARMOS_ALLOW_WRITES=true` on the server. Turn that on only after the account’s farmOS role is the one you want (this deploy uses `farm_worker`).
