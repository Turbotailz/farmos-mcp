# Homelab deploy

The container binds `0.0.0.0:8787` inside the network namespace and is published only on the host loopback. Cloudflare Tunnel, which this homelab already runs as a remotely managed token, publishes it as `https://farmos-mcp.dunslaw.com.au`.

## 1. Env file on the homelab

```bash
ssh sam@homelab 'mkdir -p /DATA/AppData/farmos-mcp/state && chmod 700 /DATA/AppData/farmos-mcp'
scp ~/.config/farmos-mcp/dunslaw.env sam@homelab:/DATA/AppData/farmos-mcp/dunslaw.env
ssh sam@homelab 'chmod 600 /DATA/AppData/farmos-mcp/dunslaw.env'
```

The file needs `FARMOS_URL`, `FARMOS_CLIENT_ID`, `FARMOS_CLIENT_SECRET`, and `FARMOS_MCP_HTTP_TOKEN`. Writes stay off.

## 2. Build and run

From this repo on the homelab (the host is amd64; build there rather than shipping a Mac image):

```bash
docker compose up -d --build
curl -sS http://127.0.0.1:8787/health
```

`/health` is unauthenticated and returns `{"ok":true}`. `/mcp` without the bearer token returns 401.

## 3. Cloudflare hostname

The tunnel (`big-bear-cloudflared-web`, host networking) publishes this hostname. Universal SSL only covers one label under `dunslaw.com.au`, so the name is `farmos-mcp.dunslaw.com.au`, not `mcp.farm.dunslaw.com.au`.

Public hostname:

| Hostname | Service |
|----------|---------|
| `farmos-mcp.dunslaw.com.au` | `http://localhost:8787` |

No Access policy on this hostname if ChatGPT and Gemini must connect: their servers cannot complete a Cloudflare Access login. The bearer token is the lock. Do not also publish port 8787 on the router.

## 4. Check from outside

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://farmos-mcp.dunslaw.com.au/health
curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://farmos-mcp.dunslaw.com.au/mcp
```

Health should be 200. The MCP post without a token should be 401.
