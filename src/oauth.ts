import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isLoopbackHost } from "./config.js";

const CHAT_HOSTS = new Set([
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "gemini.google.com",
]);

/** Hosts Gemini Spark uses for the OAuth redirect. Exact host match only. */
const GOOGLE_REDIRECT_HOSTS = new Set([
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
  "oauth-redirect-test.googleusercontent.com",
]);

export interface AuthCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  exp: number;
}

export interface RefreshRecord {
  clientId: string;
  exp: number;
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function redirectAllowed(uri: string, extra: string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return true;
  if (url.protocol !== "https:") return false;
  if (CHAT_HOSTS.has(url.hostname) || GOOGLE_REDIRECT_HOSTS.has(url.hostname)) return true;
  return extra.some((allowed) => uri === allowed);
}

export function requestOriginAllowed(origin: string | undefined, requestHost: string | undefined, extra: string[] = []): boolean {
  if (!origin || origin === "null") return true;
  try {
    const originHost = new URL(origin).host;
    const host = (requestHost || "").split(",")[0].trim();
    if (host && originHost === host) return true;
  } catch {
    return false;
  }
  return originAllowedHost(origin, extra);
}

export function originAllowedHost(origin: string | undefined, extra: string[] = []): boolean {
  if (!origin || origin === "null") return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return true;
  if (url.protocol === "https:" && (CHAT_HOSTS.has(url.hostname) || GOOGLE_REDIRECT_HOSTS.has(url.hostname))) {
    return true;
  }
  return extra.includes(origin);
}

export function publicBase(request: { headers: { host?: string; "x-forwarded-proto"?: string | string[] } }, configured?: string): string {
  if (configured) return configured.replace(/\/+$/, "");
  const host = request.headers.host || "127.0.0.1";
  const forwarded = request.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim()
    || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

export class OauthBroker {
  private codes = new Map<string, AuthCode>();
  private refresh = new Map<string, RefreshRecord>();

  constructor(
    private readonly accessToken: string,
    private readonly stateFile?: string,
  ) {
    if (!stateFile) return;
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, RefreshRecord>;
      const now = Date.now();
      for (const [token, record] of Object.entries(parsed)) {
        if (record.exp > now) this.refresh.set(token, record);
      }
    } catch {
      // missing or unreadable state is fine
    }
  }

  issueCode(input: { clientId: string; redirectUri: string; challenge: string }): string {
    this.prune();
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { ...input, exp: Date.now() + 10 * 60 * 1000 });
    return code;
  }

  exchangeCode(input: { code: string; verifier: string; clientId: string; redirectUri: string }): { accessToken: string; refreshToken: string } {
    const record = this.codes.get(input.code);
    this.codes.delete(input.code);
    if (!record || record.exp < Date.now()) throw new Error("Authorization code is invalid or expired");
    if (record.clientId !== input.clientId || record.redirectUri !== input.redirectUri) {
      throw new Error("Authorization code does not match this client");
    }
    if (pkceS256(input.verifier) !== record.challenge) throw new Error("PKCE verification failed");
    return { accessToken: this.accessToken, refreshToken: this.issueRefresh(input.clientId) };
  }

  exchangeRefresh(token: string, clientId: string): { accessToken: string; refreshToken: string } {
    const record = this.refresh.get(token);
    if (!record || record.exp < Date.now() || record.clientId !== clientId) {
      throw new Error("Refresh token is invalid or expired");
    }
    this.refresh.delete(token);
    this.persist();
    return { accessToken: this.accessToken, refreshToken: this.issueRefresh(clientId) };
  }

  private issueRefresh(clientId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.refresh.set(token, { clientId, exp: Date.now() + 90 * 24 * 60 * 60 * 1000 });
    this.persist();
    return token;
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, record] of this.codes) {
      if (record.exp < now) this.codes.delete(code);
    }
  }

  private persist(): void {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const payload: Record<string, RefreshRecord> = {};
    const now = Date.now();
    for (const [token, record] of this.refresh) {
      if (record.exp > now) payload[token] = record;
    }
    writeFileSync(this.stateFile, JSON.stringify(payload), { mode: 0o600 });
  }
}

export function loginPage(params: URLSearchParams, error?: string): string {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"]
    .map((key) => {
      const value = params.get(key) ?? "";
      return `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`;
    })
    .join("");
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>farmOS MCP</title>
  <style>
    body { font: 16px/1.4 Georgia, serif; background: #e7efe4; color: #1c2b22; margin: 0; }
    main { max-width: 28rem; margin: 12vh auto; padding: 1.5rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
    p { margin: 0 0 1rem; }
    label { display: block; font-size: 0.9rem; margin-bottom: 0.35rem; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.6rem; font: inherit; }
    button { margin-top: 0.8rem; padding: 0.55rem 0.9rem; font: inherit; background: #245c3a; color: white; border: 0; }
    .error { color: #8a1f1f; }
  </style>
</head>
<body>
  <main>
    <h1>farmOS MCP</h1>
    <p>Enter the shared access token to connect this assistant to the farm.</p>
    ${message}
    <form method="post" action="/authorize">
      ${hidden}
      <label for="access_token">Access token</label>
      <input id="access_token" name="access_token" type="password" autocomplete="current-password" required>
      <button type="submit">Connect</button>
    </form>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
