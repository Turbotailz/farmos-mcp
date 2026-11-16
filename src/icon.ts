import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function loadIcon(): Buffer {
  const candidates = [
    join(here, "../../assets/icon.png"),
    join(here, "../assets/icon.png"),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path);
    } catch {
      // try the next location
    }
  }
  throw new Error("farmOS MCP icon is missing");
}

export const iconPng = loadIcon();

export function iconDataUri(): string {
  return `data:image/png;base64,${iconPng.toString("base64")}`;
}

export function publicIconUrl(): string | undefined {
  const base = process.env.FARMOS_MCP_PUBLIC_URL?.replace(/\/+$/, "");
  return base ? `${base}/icon.png` : undefined;
}
