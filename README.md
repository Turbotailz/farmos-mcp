# farmos-mcp

MCP server for a [farmOS](https://farmos.org) 4.x site. It speaks JSON:API, so the same server works in Cursor over stdio and in ChatGPT or Gemini over Streamable HTTP.

Reads are on by default. Creates and updates stay off until `FARMOS_ALLOW_WRITES=true`. There is no delete tool. The server will not create users, roles, or configuration, and it will only call the host in `FARMOS_URL`.

## Tools

| Tool | What it does |
|------|----------------|
| `farm_info` | Farm name, version, units, and whether writes are on |
| `list_resource_types` | Entity types and bundles on this server |
| `search_assets` | Equipment, land, animals, and other assets |
| `get_record` | One record by UUID |
| `list_logs` | Logs by type, status, asset, text, or date |
| `list_plans` | Plans by status, name, or archived flag |
| `list_terms` | Taxonomy terms (units, categories, …) |
| `create_log` / `update_log` | Record or correct a log (writes) |
| `create_record` / `update_record` | Assets, plans, quantities, terms (writes) |

## farmOS setup

farmOS 4 does not enable the API at install.

1. Enable `farm_api`, `farm_api_oauth`, and a role module such as `farm_worker`.
2. Generate OAuth keys under Administration → Configuration → Web Services → Consumers → Settings. Keep the private key outside the public files directory.
3. Create a consumer with the client credentials grant, a secret, the `farm_worker` scope, and a dedicated user who has that role.

Password grant also works (`FARMOS_USERNAME` / `FARMOS_PASSWORD`) if `simple_oauth_password_grant` is enabled. Client credentials are the better fit for an unattended server.

## Configure

```bash
cp .env.example ~/.config/farmos-mcp/dunslaw.env
chmod 600 ~/.config/farmos-mcp/dunslaw.env
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "farmos": {
      "command": "npx",
      "args": ["-y", "farmos-mcp"],
      "env": {
        "FARMOS_ENV_FILE": "/home/you/.config/farmos-mcp/dunslaw.env"
      }
    }
  }
}
```

Claude Desktop uses the same command shape. From a checkout, `node dist/bin/cli.js` after `npm run build` works the same way.

## Remote HTTP

```bash
FARMOS_ENV_FILE=~/.config/farmos-mcp/dunslaw.env \
  FARMOS_MCP_HTTP_TOKEN="$(openssl rand -hex 32)" \
  FARMOS_MCP_PUBLIC_URL=https://farmos-mcp.example.com \
  farmos-mcp --http
```

The process listens on `127.0.0.1:8787` unless `FARMOS_MCP_HOST` says otherwise. Binding anything other than loopback requires `FARMOS_MCP_HTTP_TOKEN`.

- Cursor and other hosts that can send a header use `Authorization: Bearer <token>` against `https://<public-host>/mcp`.
- ChatGPT and Gemini, which sign in with OAuth, open `/authorize`. The login form asks for that same token. The server advertises `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.
- Redirects are accepted for `chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com`, and loopback. Add an exact URI with `FARMOS_MCP_OAUTH_REDIRECTS` if a client uses another callback.

Do not put the HTTP listener on the public internet without the token. See [docs/homelab.md](docs/homelab.md) and [docs/connect.md](docs/connect.md).

## Develop

```bash
npm install
npm test
FARMOS_ENV_FILE=~/.config/farmos-mcp/dunslaw.env npm run smoke
```

`npm test` uses a mock farmOS. `npm run smoke` talks to the instance in the env file, creates one asset and one observation, then deletes them.

## License

MIT
