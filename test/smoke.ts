import { homedir } from "node:os";
import { join } from "node:path";
import { FarmClient } from "../src/client.js";
import { loadConfig, loadEnvFile } from "../src/config.js";

const envFile = process.env.FARMOS_ENV_FILE || join(homedir(), ".config/farmos-mcp/dunslaw.env");
loadEnvFile(envFile);
const config = loadConfig();
const client = new FarmClient({ ...config, allowWrites: true, allowDelete: true });

const info = await client.farmInfo();
console.log("farm", info.name, info.version, "writes_in_env", config.allowWrites);

const equipment = await client.searchAssets({ bundle: "equipment", limit: 5 });
console.log("equipment", equipment.records.length, "warnings", equipment.warnings);

const created = await client.createRecord({
  entity: "asset",
  bundle: "equipment",
  attributes: { name: "MCP smoke equipment", manufacturer: "Test", model: "None" },
});
console.log("created", created.id);
let logId: string | undefined;
try {
  const log = await client.createLog({
    bundle: "observation",
    name: "MCP smoke observation",
    notes: "Created by farmos-mcp smoke test. Safe to delete.",
    assets: [{ type: created.type, id: created.id }],
  });
  logId = log.id;
  console.log("log", log.id, log.status);
  const listed = await client.listLogs({ assetId: created.id, limit: 5 });
  console.log("listed", listed.records.map((record) => record.name), "warnings", listed.warnings);
  if (!listed.records.some((record) => record.id === log.id)) {
    throw new Error("created log was not returned by list_logs");
  }
  const updated = await client.updateLog({
    bundle: "observation",
    id: log.id,
    notes: "Updated by farmos-mcp smoke test.",
  });
  console.log("updated notes", updated.notes);
} finally {
  if (logId) await client.deleteRecord("log", "observation", logId);
  await client.deleteRecord("asset", "equipment", created.id);
  console.log("cleaned up");
}
