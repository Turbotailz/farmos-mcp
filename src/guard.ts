import type { FarmConfig } from "./config.js";

const WRITABLE = new Set(["asset", "log", "plan", "quantity", "taxonomy_term"]);

export function assertWrites(config: FarmConfig): void {
  if (!config.allowWrites) {
    throw new Error(
      "Writes are disabled. Set FARMOS_ALLOW_WRITES=true to create or update records. Users, roles, and configuration cannot be changed through this server.",
    );
  }
}

export function assertWritableEntity(entity: string): void {
  if (!WRITABLE.has(entity)) {
    throw new Error(
      `Refusing to write ${entity}. Allowed entity types: ${[...WRITABLE].join(", ")}.`,
    );
  }
}
