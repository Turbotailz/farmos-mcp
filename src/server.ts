import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FarmClient } from "./client.js";
import { loadConfig, VERSION } from "./config.js";
import { iconDataUri, publicIconUrl } from "./icon.js";
import { errorResult, textResult } from "./mcp-result.js";

const INSTRUCTIONS = [
  "This server reads and records data in one farmOS instance.",
  "Call farm_info first if you do not yet know the farm name or whether writes are enabled.",
  "Look up records with search_assets, list_logs, list_plans, list_terms, and get_record.",
  "Never invent UUIDs; copy id and type from a previous tool result.",
  "Record work with create_log (observation, activity, input, maintenance, medical).",
  "Do not call write tools when farm_info says allow_writes is false.",
].join(" ");

const refSchema = z.object({
  type: z.string().describe("JSON:API type, such as asset--equipment or taxonomy_term--log_category"),
  id: z.string().uuid(),
});

const limitSchema = z.number().int().min(1).max(50).optional().describe("Page size, default 20, max 50");

export function createMcpServer(client: FarmClient = new FarmClient(loadConfig())): McpServer {
  const server = new McpServer(
    {
      name: "farmos-mcp",
      title: "farmOS",
      version: VERSION,
      description: "Read and record records in a farmOS instance.",
      icons: [
        {
          src: publicIconUrl() ?? iconDataUri(),
          mimeType: "image/png",
          sizes: ["128x128"],
        },
      ],
    },
    { instructions: INSTRUCTIONS, maxToolInputElements: 200 },
  );

  const read = { readOnlyHint: true, openWorldHint: true, destructiveHint: false };
  const write = { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false };

  server.registerTool(
    "farm_info",
    {
      description: "Use this when you need the farm name, farmOS version, measurement system, or whether writes are enabled.",
      inputSchema: {},
      annotations: read,
    },
    async () => run(() => client.farmInfo()),
  );

  server.registerTool(
    "list_resource_types",
    {
      description: "Use this when you need the entity types and bundles on this farmOS (asset, log, plan, taxonomy). Do not guess bundle names.",
      inputSchema: {},
      annotations: read,
    },
    async () => run(async () => ({ types: await client.resourceTypes() })),
  );

  server.registerTool(
    "search_assets",
    {
      description: "Use this to find equipment, land, animals, structures, and other assets by name. Returns active assets unless archived is set.",
      inputSchema: {
        name: z.string().optional().describe("Substring match on the asset name"),
        bundle: z.string().optional().describe("One bundle, such as equipment, land, or animal"),
        archived: z.boolean().optional().describe("true for archived assets, false for active. Omit for active only."),
        limit: limitSchema,
      },
      annotations: read,
    },
    async (args) => run(() => client.searchAssets({
      name: args.name,
      bundle: args.bundle,
      archived: args.archived ?? false,
      limit: args.limit,
    })),
  );

  server.registerTool(
    "get_record",
    {
      description: "Use this to fetch one record by UUID after you already know its entity and bundle.",
      inputSchema: {
        entity: z.string().describe("Entity type, such as asset, log, plan, or taxonomy_term"),
        bundle: z.string().describe("Bundle, such as equipment, observation, or unit"),
        id: z.string().uuid(),
      },
      annotations: read,
    },
    async (args) => run(() => client.getRecord(args.entity, args.bundle, args.id)),
  );

  server.registerTool(
    "list_logs",
    {
      description: "Use this to list farm logs. Filter by bundle, status, asset, name, or date. Dates are ISO-8601.",
      inputSchema: {
        bundle: z.string().optional().describe("Log bundle, such as activity, observation, input, or maintenance"),
        status: z.enum(["pending", "done", "abandoned"]).optional(),
        name: z.string().optional(),
        asset_id: z.string().uuid().optional().describe("Only logs linked to this asset UUID"),
        from: z.string().optional().describe("Inclusive start, ISO-8601"),
        to: z.string().optional().describe("Inclusive end, ISO-8601"),
        limit: limitSchema,
      },
      annotations: read,
    },
    async (args) => run(() => client.listLogs({
      bundle: args.bundle,
      status: args.status,
      name: args.name,
      assetId: args.asset_id,
      from: args.from,
      to: args.to,
      limit: args.limit,
    })),
  );

  server.registerTool(
    "list_plans",
    {
      description: "Use this to list farm plans by status, name, or archived flag.",
      inputSchema: {
        bundle: z.string().optional(),
        status: z.enum(["planning", "active", "done", "abandoned"]).optional(),
        name: z.string().optional(),
        archived: z.boolean().optional(),
        limit: limitSchema,
      },
      annotations: read,
    },
    async (args) => run(() => client.listPlans({
      ...args,
      archived: args.archived ?? false,
    })),
  );

  server.registerTool(
    "list_terms",
    {
      description: "Use this to list taxonomy terms in one vocabulary, such as unit, log_category, or plant_type.",
      inputSchema: {
        vocabulary: z.string().describe("Taxonomy vocabulary machine name, such as unit or log_category"),
        name: z.string().optional(),
        limit: limitSchema,
      },
      annotations: read,
    },
    async (args) => run(() => client.listTerms(args.vocabulary, args.name, args.limit)),
  );

  server.registerTool(
    "create_log",
    {
      description: "Use this to record work on the farm (an observation, activity, input, maintenance, or medical log). Requires FARMOS_ALLOW_WRITES=true. Copy asset type and id from search_assets.",
      inputSchema: {
        bundle: z.string().default("observation").describe("Log bundle. Default observation."),
        name: z.string().min(1),
        status: z.enum(["pending", "done", "abandoned"]).default("done"),
        notes: z.string().optional(),
        timestamp: z.string().optional().describe("When it happened, ISO-8601. Defaults to now."),
        assets: z.array(refSchema).optional(),
        locations: z.array(refSchema).optional(),
        categories: z.array(refSchema).optional(),
        quantity: z.object({
          measure: z.string().describe("farmOS measure, such as weight, volume, or count"),
          value: z.number(),
          label: z.string().optional(),
          unit_id: z.string().uuid().optional().describe("taxonomy_term--unit UUID from list_terms"),
        }).optional(),
      },
      annotations: write,
    },
    async (args) => run(() => client.createLog(args)),
  );

  server.registerTool(
    "update_log",
    {
      description: "Use this to change the name, status, notes, or timestamp of an existing log. Requires FARMOS_ALLOW_WRITES=true.",
      inputSchema: {
        bundle: z.string(),
        id: z.string().uuid(),
        name: z.string().optional(),
        status: z.enum(["pending", "done", "abandoned"]).optional(),
        notes: z.string().optional(),
        timestamp: z.string().optional(),
      },
      annotations: write,
    },
    async (args) => run(() => client.updateLog(args)),
  );

  server.registerTool(
    "create_record",
    {
      description: "Use this to create an asset, plan, quantity, or taxonomy term. Prefer create_log for events. Requires FARMOS_ALLOW_WRITES=true. Cannot create users or configuration.",
      inputSchema: {
        entity: z.enum(["asset", "log", "plan", "quantity", "taxonomy_term"]),
        bundle: z.string(),
        attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
          .describe("Plain fields such as name, manufacturer, model, status, or archived. notes may be a string."),
        relationships: z.array(z.object({
          field: z.string(),
          refs: z.array(refSchema).min(1),
        })).optional(),
      },
      annotations: write,
    },
    async (args) => run(() => client.createRecord(args)),
  );

  server.registerTool(
    "update_record",
    {
      description: "Use this to change fields on an asset, log, plan, quantity, or term. Sending a relationship replaces that relationship. Requires FARMOS_ALLOW_WRITES=true.",
      inputSchema: {
        entity: z.enum(["asset", "log", "plan", "quantity", "taxonomy_term"]),
        bundle: z.string(),
        id: z.string().uuid(),
        attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
        relationships: z.array(z.object({
          field: z.string(),
          refs: z.array(refSchema).min(1),
        })).optional(),
      },
      annotations: { ...write, idempotentHint: true },
    },
    async (args) => run(() => client.updateRecord(args)),
  );

  return server;
}

async function run(fn: () => Promise<unknown>) {
  try {
    return textResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

export async function runStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
