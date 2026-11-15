import { readFileSync } from "node:fs";

export const VERSION = "0.1.0";

export interface FarmConfig {
  url: string;
  clientId: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  scope: string;
  allowWrites: boolean;
  allowDelete: boolean;
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function assertBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`FARMOS_URL is not a valid URL: ${raw}`);
  }
  if (url.username || url.password) {
    throw new Error("FARMOS_URL must not include credentials");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("FARMOS_URL must be https, or http on localhost");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

/** Rewrite a farmOS link onto the configured origin. Refuses any other host. */
export function resolveFarmUrl(base: URL, pathOrUrl: string): URL {
  const next = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl, base);
  if (next.hostname !== base.hostname) {
    throw new Error(`Refusing to call ${next.hostname}; only ${base.hostname} is configured`);
  }
  if (next.protocol !== "https:" && next.protocol !== "http:") {
    throw new Error(`Refusing ${next.protocol} URL`);
  }
  // farmOS behind a tunnel often advertises http links. Always call the configured origin.
  next.protocol = base.protocol;
  next.host = base.host;
  return next;
}

export function flag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FarmConfig {
  const rawUrl = env.FARMOS_URL?.trim();
  if (!rawUrl) throw new Error("FARMOS_URL is required");
  const url = assertBaseUrl(rawUrl);
  const clientId = env.FARMOS_CLIENT_ID?.trim() || "farm";
  const clientSecret = env.FARMOS_CLIENT_SECRET?.trim() || undefined;
  const username = env.FARMOS_USERNAME?.trim() || undefined;
  const password = env.FARMOS_PASSWORD?.trim() || undefined;
  if (!clientSecret && !(username && password)) {
    throw new Error("Set FARMOS_CLIENT_SECRET (client credentials) or FARMOS_USERNAME and FARMOS_PASSWORD");
  }
  return {
    url: url.origin + url.pathname,
    clientId,
    clientSecret,
    username,
    password,
    scope: env.FARMOS_SCOPE?.trim() || "farm_worker",
    allowWrites: flag(env.FARMOS_ALLOW_WRITES),
    allowDelete: flag(env.FARMOS_ALLOW_DELETE),
  };
}

export function baseUrl(config: FarmConfig): URL {
  return new URL(config.url.endsWith("/") ? config.url : `${config.url}/`);
}
