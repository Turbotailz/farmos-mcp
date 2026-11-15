import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FarmSession } from "./client.js";
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
  session: FarmSession;
}

export interface RefreshRecord {
  accessToken: string;
  clientId: string;
  exp: number;
}

interface AccessRecord {
  clientId: string;
  exp: number;
  session: FarmSession;
}

interface StoredSessions {
  version: 2;
  access: Record<string, AccessRecord>;
  refresh: Record<string, RefreshRecord>;
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
  private access = new Map<string, AccessRecord>();
  private refresh = new Map<string, RefreshRecord>();

  constructor(private readonly stateFile?: string) {
    if (!stateFile) return;
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as StoredSessions;
      if (parsed.version !== 2) return;
      const now = Date.now();
      for (const [token, record] of Object.entries(parsed.access ?? {})) {
        if (record.exp > now) this.access.set(token, record);
      }
      for (const [token, record] of Object.entries(parsed.refresh ?? {})) {
        if (record.exp > now) this.refresh.set(token, record);
      }
    } catch {
      // missing or unreadable state is fine
    }
  }

  issueCode(input: { clientId: string; redirectUri: string; challenge: string; session: FarmSession }): string {
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
    return this.issuePair(record.clientId, record.session);
  }

  exchangeRefresh(token: string, clientId: string): { accessToken: string; refreshToken: string } {
    const record = this.refresh.get(token);
    if (!record || record.exp < Date.now() || record.clientId !== clientId) {
      throw new Error("Refresh token is invalid or expired");
    }
    const current = this.access.get(record.accessToken);
    if (!current) throw new Error("Refresh token is invalid or expired");
    this.refresh.delete(token);
    this.access.delete(record.accessToken);
    return this.issuePair(clientId, current.session);
  }

  getSession(accessToken: string): FarmSession | undefined {
    const record = this.access.get(accessToken);
    if (!record || record.exp < Date.now()) return undefined;
    return record.session;
  }

  updateSession(accessToken: string, session: FarmSession): void {
    const record = this.access.get(accessToken);
    if (!record) return;
    record.session = session;
    this.persist();
  }

  private issuePair(clientId: string, session: FarmSession): { accessToken: string; refreshToken: string } {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const accessExp = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const refreshExp = Date.now() + 90 * 24 * 60 * 60 * 1000;
    this.access.set(accessToken, { clientId, exp: accessExp, session });
    this.refresh.set(refreshToken, { accessToken, clientId, exp: refreshExp });
    this.persist();
    return { accessToken, refreshToken };
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
    const now = Date.now();
    const payload: StoredSessions = { version: 2, access: {}, refresh: {} };
    for (const [token, record] of this.access) {
      if (record.exp > now) payload.access[token] = record;
    }
    for (const [token, record] of this.refresh) {
      if (record.exp > now) payload.refresh[token] = record;
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
    input { width: 100%; box-sizing: border-box; padding: 0.6rem; font: inherit; margin-bottom: 0.7rem; }
    button { margin-top: 0.8rem; padding: 0.55rem 0.9rem; font: inherit; background: #245c3a; color: white; border: 0; }
    .error { color: #8a1f1f; }
  </style>
</head>
<body>
  <main>
    <h1>farmOS MCP</h1>
    <p>Sign in with your farmOS account. What you record is saved under your name.</p>
    ${message}
    <form method="post" action="/authorize">
      ${hidden}
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
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
