# Connect an assistant

The HTTP server has to be up and the hostname has to resolve. See [homelab.md](homelab.md). Each person signs in with their own farmOS username and password. Records are stored under that account. Usernames are `nik`, `sam`, `orestis`, `stavros`, and `achilleas`. Passwords are in `~/.config/farmos-mcp/accounts.txt` on Sam's Mac.

## Cursor

Already configured in `~/.cursor/mcp.json` as `farmos`. It runs on this Mac and signs in as `sam`. Reload the Cursor window after a credential change. Ask: "Use farmOS. Who am I signed in as?"

## Grok bot

Grok's servers call the public URL and send a bearer token. They do not open the browser login. The token is `FARMOS_MCP_HTTP_TOKEN` in `~/.config/farmos-mcp/dunslaw.env`. The bot acts as `sam`.

1. Open [grok.com/connectors](https://grok.com/connectors).
2. New Connector, Custom.
3. URL: `https://farmos-mcp.dunslaw.com.au/mcp`
4. Header: `Authorization: Bearer <the token>`

Or, if the `grok` CLI is signed in:

```bash
set -a; source ~/.config/farmos-mcp/dunslaw.env; set +a
grok mcp add --transport http farmos https://farmos-mcp.dunslaw.com.au/mcp \
  --header "Authorization: Bearer ${FARMOS_MCP_HTTP_TOKEN}"
```

## ChatGPT

1. Plugins → Add custom MCP server.
2. Server URL: `https://farmos-mcp.dunslaw.com.au/mcp`
3. Authentication: OAuth.
4. When the browser opens the farmOS MCP login, sign in with your farmOS username and password.
5. Ask: “Use the farmOS app. What is the farm name, and which equipment assets exist?”

If ChatGPT reports a redirect URI error, copy the URI from the error into `FARMOS_MCP_OAUTH_REDIRECTS` (comma-separated, exact match) and recreate the container.

## Gemini

Add a custom app with server URL `https://farmos-mcp.dunslaw.com.au/mcp`. Leave Client ID and Client secret empty, then click Next. Gemini registers itself. The login page then asks for your farmOS username and password. An existing Gemini connection that used the shared token has to be removed and added again.

## Claude (remote)

Claude Desktop on the same computer should use the stdio command instead. A remote Claude connector uses the same HTTPS URL and OAuth login. `claude.ai` callbacks are allowed.

## What people can do

With the default env file, the assistant can look up assets, logs, plans, and terms. It cannot create records until `FARMOS_ALLOW_WRITES=true` on the server. Turn that on only after the account’s farmOS role is the one you want (this deploy uses `farm_worker`).
