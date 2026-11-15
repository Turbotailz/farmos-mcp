process.env.FARMOS_URL ??= "https://farm.example.com";
process.env.FARMOS_CLIENT_SECRET ??= "test-secret";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pkceS256, redirectAllowed, safeEqual } from "../src/oauth.js";
import { startHttpServer } from "../src/http.js";

describe("oauth helpers", () => {
  it("compares tokens without matching the raw string", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
  });

  it("allows assistant redirects, including Gemini's Google redirect host", () => {
    assert.equal(redirectAllowed("https://chatgpt.com/connector/oauth/callback"), true);
    assert.equal(redirectAllowed("http://127.0.0.1:3344/callback"), true);
    assert.equal(redirectAllowed("https://oauth-redirect.googleusercontent.com/r/farm"), true);
    assert.equal(redirectAllowed("https://evil.googleusercontent.com/r/farm"), false);
    assert.equal(redirectAllowed("https://evil.example/steal"), false);
    assert.equal(redirectAllowed("https://example.com/ok", ["https://example.com/ok"]), true);
  });
});

const http = await startHttpServer({
  host: "127.0.0.1",
  port: 0,
  token: "shared-token",
  stateFile: join(mkdtempSync(join(tmpdir(), "farmos-mcp-")), "refresh-tokens.json"),
});
after(() => http.close());

describe("http server", () => {

  it("refuses MCP calls without the bearer token", async () => {
    const response = await fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") || "", /oauth-protected-resource/);
  });

  it("answers initialize when the bearer token matches", async () => {
    const response = await fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer shared-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { result?: { serverInfo?: { name?: string } } };
    assert.equal(body.result?.serverInfo?.name, "farmos-mcp");
  });

  it("registers a Gemini client from the browser origin", async () => {
    const response = await fetch(`${http.url}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://gemini.google.com",
      },
      body: JSON.stringify({
        client_name: "Gemini",
        redirect_uris: ["https://oauth-redirect.googleusercontent.com/r/farmos-mcp"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://gemini.google.com");
    const body = await response.json() as { client_id?: string; token_endpoint_auth_method?: string };
    assert.ok(body.client_id);
    assert.equal(body.token_endpoint_auth_method, "none");
    const metadata = await fetch(`${http.url}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(metadata.status, 200);
  });

  it("exchanges an authorization code after the login form", async () => {
    const verifier = "a".repeat(48);
    const challenge = pkceS256(verifier);
    const redirect = "http://127.0.0.1:9/callback";
    const params = new URLSearchParams({
      client_id: "chatgpt",
      redirect_uri: redirect,
      state: "xyz",
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_token: "shared-token",
    });
    const login = await fetch(`${http.url}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
      redirect: "manual",
    });
    assert.equal(login.status, 302);
    const location = new URL(login.headers.get("location") || "");
    assert.equal(location.searchParams.get("state"), "xyz");
    const code = location.searchParams.get("code");
    assert.ok(code);
    const token = await fetch(`${http.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code || "",
        code_verifier: verifier,
        client_id: "chatgpt",
        redirect_uri: redirect,
      }),
    });
    const issued = await token.json() as { access_token?: string; refresh_token?: string };
    assert.equal(token.status, 200);
    assert.equal(issued.access_token, "shared-token");
    assert.ok(issued.refresh_token);
  });
});

describe("bind policy", () => {
  it("refuses a public bind without a token", async () => {
    await assert.rejects(
      () => startHttpServer({ host: "0.0.0.0", port: 0 }),
      /FARMOS_MCP_HTTP_TOKEN/,
    );
  });
});
