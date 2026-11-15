import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isLoopbackHost } from "./config.js";
import { createMcpServer } from "./server.js";
import {
  loginPage,
  OauthBroker,
  originAllowedHost,
  publicBase,
  redirectAllowed,
  safeEqual,
} from "./oauth.js";

export interface HttpOptions {
  host: string;
  port: number;
  token?: string;
  publicUrl?: string;
  extraRedirects?: string[];
  stateFile?: string;
}

export function assertHttpBind(host: string, token: string | undefined): void {
  if (!isLoopbackHost(host) && !token) {
    throw new Error("FARMOS_MCP_HTTP_TOKEN is required when FARMOS_MCP_HOST is not a loopback address");
  }
}

export async function startHttpServer(options: HttpOptions): Promise<{ url: string; close: () => Promise<void> }> {
  assertHttpBind(options.host, options.token);
  const broker = options.token
    ? new OauthBroker(options.token, options.stateFile)
    : undefined;

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, options, broker);
    } catch (err) {
      if (res.headersSent) return;
      const message = err instanceof Error ? err.message : "Request failed";
      sendJson(res, 400, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${options.host}:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpOptions,
  broker: OauthBroker | undefined,
): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "OPTIONS") {
    if (!originAllowed(req)) {
      sendJson(res, 403, { error: "Origin is not allowed" }, req);
      return;
    }
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  if (!originAllowed(req)) {
    sendJson(res, 403, { error: "Origin is not allowed" }, req);
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  const base = publicBase(req, options.publicUrl);
  if (req.method === "GET" && isWellKnown(url.pathname, "oauth-protected-resource")) {
    sendJson(res, 200, {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
    }, req);
    return;
  }
  if (req.method === "GET" && isWellKnown(url.pathname, "oauth-authorization-server")) {
    sendJson(res, 200, authorizationServerMetadata(base), req);
    return;
  }
  if (req.method === "POST" && url.pathname === "/register") {
    const body = await readBody(req) as { redirect_uris?: string[]; client_name?: string };
    const redirects = body.redirect_uris ?? [];
    const rejected = redirects.filter((uri) => !redirectAllowed(uri, options.extraRedirects));
    if (!redirects.length || rejected.length) {
      console.error(`farmos-mcp: rejected client registration redirect_uris=${JSON.stringify(redirects)}`);
      sendJson(res, 400, {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is empty or not allowed",
      }, req);
      return;
    }
    sendJson(res, 201, {
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.client_name || "farmos-mcp",
      redirect_uris: redirects,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }, req);
    return;
  }
  if (url.pathname === "/authorize") {
    await authorize(req, res, options, broker);
    return;
  }
  if (req.method === "POST" && url.pathname === "/token") {
    await token(req, res, broker);
    return;
  }
  if (url.pathname === "/mcp") {
    await mcp(req, res, options);
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

async function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpOptions,
  broker: OauthBroker | undefined,
): Promise<void> {
  if (!options.token || !broker) throw new Error("OAuth is not configured");
  const params = req.method === "GET"
    ? new URL(req.url || "/", "http://localhost").searchParams
    : new URLSearchParams(await readRaw(req));
  const redirectUri = params.get("redirect_uri") || "";
  const clientId = params.get("client_id") || "";
  const challenge = params.get("code_challenge") || "";
  const method = params.get("code_challenge_method") || "S256";
  if (!redirectAllowed(redirectUri, options.extraRedirects)) throw new Error("redirect_uri is not allowed");
  if (!clientId || method !== "S256" || !challenge) throw new Error("PKCE S256 is required");
  if (req.method === "GET") {
    sendHtml(res, 200, loginPage(params));
    return;
  }
  const provided = params.get("access_token") || "";
  if (!safeEqual(provided, options.token)) {
    sendHtml(res, 401, loginPage(params, "That token was not accepted."));
    return;
  }
  const code = broker.issueCode({ clientId, redirectUri, challenge });
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  const state = params.get("state");
  if (state) target.searchParams.set("state", state);
  res.writeHead(302, { Location: target.toString() });
  res.end();
}

async function token(req: IncomingMessage, res: ServerResponse, broker: OauthBroker | undefined): Promise<void> {
  if (!broker) throw new Error("OAuth is not configured");
  const params = new URLSearchParams(await readRaw(req));
  const grant = params.get("grant_type");
  const clientId = params.get("client_id") || "";
  try {
    const issued = grant === "refresh_token"
      ? broker.exchangeRefresh(params.get("refresh_token") || "", clientId)
      : broker.exchangeCode({
          code: params.get("code") || "",
          verifier: params.get("code_verifier") || "",
          clientId,
          redirectUri: params.get("redirect_uri") || "",
        });
    sendJson(res, 200, {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: 30 * 24 * 60 * 60,
      refresh_token: issued.refreshToken,
    });
  } catch (err) {
    sendJson(res, 400, {
      error: "invalid_grant",
      error_description: err instanceof Error ? err.message : "invalid grant",
    });
  }
}

async function mcp(req: IncomingMessage, res: ServerResponse, options: HttpOptions): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST only" });
    return;
  }
  if (options.token) {
    const header = req.headers.authorization || "";
    const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!presented || !safeEqual(presented, options.token)) {
      const base = publicBase(req, options.publicUrl);
      res.writeHead(401, {
        ...corsHeaders(req),
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }
  const body = await readBody(req);
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void mcpServer.close().catch(() => undefined);
  });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

function originAllowed(req: IncomingMessage): boolean {
  const extra = (process.env.FARMOS_MCP_ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
  return originAllowedHost(req.headers.origin, extra);
}

function isWellKnown(pathname: string, name: string): boolean {
  return pathname === `/.well-known/${name}` || pathname === `/.well-known/${name}/mcp`;
}

function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(req)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const text = await readRaw(req);
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage): void {
  res.writeHead(status, { "Content-Type": "application/json", ...(req ? corsHeaders(req) : {}) });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
