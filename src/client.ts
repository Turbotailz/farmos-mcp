import { baseUrl, resolveFarmUrl, type FarmConfig } from "./config.js";
import { singleFlight } from "./single-flight.js";
import { assertWritableEntity, assertWrites } from "./guard.js";
import { summarizeRecord, toFraction, toUnix, type RecordSummary, type ResourceRef } from "./summarize.js";

export interface ResourceType {
  entity: string;
  bundle: string;
  type: string;
  path: string;
}

export interface ListResult {
  records: RecordSummary[];
  truncated: boolean;
  warnings: string[];
}

export interface LogInput {
  bundle: string;
  name: string;
  status?: string;
  notes?: string;
  timestamp?: string | number;
  assets?: ResourceRef[];
  locations?: ResourceRef[];
  categories?: ResourceRef[];
  quantity?: {
    measure: string;
    value: number;
    label?: string;
    unit_id?: string;
  };
}

export interface LogPatch {
  bundle: string;
  id: string;
  name?: string;
  status?: string;
  notes?: string;
  timestamp?: string | number;
}

export interface RecordInput {
  entity: string;
  bundle: string;
  attributes?: Record<string, string | number | boolean | null>;
  relationships?: { field: string; refs: ResourceRef[] }[];
}

export interface RecordPatch extends RecordInput {
  id: string;
}

interface JsonApiDocument {
  data?: JsonApiResource | JsonApiResource[];
  links?: Record<string, { href?: string } | string>;
  meta?: {
    farm?: {
      name?: string;
      url?: string;
      version?: string;
      system_of_measurement?: string;
    };
    links?: { me?: { href?: string; meta?: { id?: string } } };
  };
  errors?: { status?: string; title?: string; detail?: string }[];
}

interface JsonApiResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: ResourceRef | ResourceRef[] | null }>;
}

const LOG_STATUS = new Set(["pending", "done", "abandoned"]);

export interface FarmSession {
  username: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface FarmActor {
  username: string;
  getAccessToken(): Promise<string>;
}

export class FarmClient {
  private token?: { value: string; expiresAt: number };
  private tokenFlight?: Promise<string>;
  private types?: ResourceType[];

  constructor(
    readonly config: FarmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly actor?: FarmActor,
  ) {}

  async farmInfo(): Promise<Record<string, unknown>> {
    const doc = await this.getJson("/api");
    const me = doc.meta?.links?.me;
    return {
      name: doc.meta?.farm?.name ?? null,
      version: doc.meta?.farm?.version ?? null,
      system_of_measurement: doc.meta?.farm?.system_of_measurement ?? null,
      url: this.config.url,
      user: this.actor?.username ?? this.config.username ?? null,
      user_id: me?.meta?.id ?? null,
      allow_writes: this.config.allowWrites,
      allow_delete: this.config.allowDelete,
      scope: this.config.scope,
      resource_type_count: (await this.resourceTypes()).length,
    };
  }

  async resourceTypes(): Promise<ResourceType[]> {
    if (this.types) return this.types;
    const doc = await this.getJson("/api");
    const types: ResourceType[] = [];
    for (const [key, value] of Object.entries(doc.links ?? {})) {
      if (!key.includes("--")) continue;
      const href = typeof value === "string" ? value : value?.href;
      if (!href) continue;
      const [entity, bundle] = key.split("--");
      if (!entity || !bundle) continue;
      const path = new URL(href, this.config.url).pathname;
      types.push({ entity, bundle, type: key, path });
    }
    this.types = types;
    return types;
  }

  async searchAssets(query: {
    name?: string;
    bundle?: string;
    archived?: boolean;
    limit?: number;
  }): Promise<ListResult> {
    return this.listAcross("asset", query.bundle, {
      name: query.name,
      archived: query.archived,
      limit: query.limit,
      sort: "-changed",
    });
  }

  async listLogs(query: {
    bundle?: string;
    status?: string;
    name?: string;
    assetId?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<ListResult> {
    return this.listAcross("log", query.bundle, {
      name: query.name,
      status: query.status,
      assetId: query.assetId,
      from: query.from,
      to: query.to,
      limit: query.limit,
      sort: "-timestamp",
    });
  }

  async listPlans(query: {
    bundle?: string;
    status?: string;
    name?: string;
    archived?: boolean;
    limit?: number;
  }): Promise<ListResult> {
    return this.listAcross("plan", query.bundle, {
      name: query.name,
      status: query.status,
      archived: query.archived,
      limit: query.limit,
      sort: "-changed",
    });
  }

  async listTerms(vocabulary: string, name?: string, limit?: number): Promise<ListResult> {
    const page = await this.collection("taxonomy_term", vocabulary, filters({
      name,
      limit: cap(limit),
      sort: "name",
    }));
    return { records: page.records, truncated: page.truncated, warnings: [] };
  }

  async getRecord(entity: string, bundle: string, id: string): Promise<RecordSummary> {
    const doc = await this.getJson(`/api/${entity}/${bundle}/${id}`);
    const data = one(doc);
    if (!data?.id) throw new Error(`Record ${entity}/${bundle}/${id} was not found`);
    return summarizeRecord(data);
  }

  async createLog(input: LogInput): Promise<RecordSummary> {
    assertWrites(this.config);
    if (input.status && !LOG_STATUS.has(input.status)) {
      throw new Error(`Log status must be pending, done, or abandoned`);
    }
    const relationships: Record<string, { data: ResourceRef[] }> = {};
    if (input.assets?.length) relationships.asset = { data: input.assets };
    if (input.locations?.length) relationships.location = { data: input.locations };
    if (input.categories?.length) relationships.category = { data: input.categories };
    if (input.quantity) {
      const quantity = await this.createRecord({
        entity: "quantity",
        bundle: "standard",
        attributes: {
          measure: input.quantity.measure,
          label: input.quantity.label ?? "",
        },
        relationships: input.quantity.unit_id
          ? [{
              field: "units",
              refs: [{ type: "taxonomy_term--unit", id: input.quantity.unit_id }],
            }]
          : undefined,
      }, {
        value: toFraction(input.quantity.value),
      });
      relationships.quantity = { data: [{ type: quantity.type, id: quantity.id }] };
    }
    const attributes: Record<string, unknown> = {
      name: input.name,
      status: input.status ?? "done",
      timestamp: toUnix(input.timestamp) ?? Math.floor(Date.now() / 1000),
    };
    if (input.notes) attributes.notes = { value: input.notes, format: "plain_text" };
    return this.postResource("log", input.bundle, attributes, relationships);
  }

  async updateLog(input: LogPatch): Promise<RecordSummary> {
    assertWrites(this.config);
    if (input.status && !LOG_STATUS.has(input.status)) {
      throw new Error(`Log status must be pending, done, or abandoned`);
    }
    const attributes: Record<string, unknown> = {};
    if (input.name !== undefined) attributes.name = input.name;
    if (input.status !== undefined) attributes.status = input.status;
    if (input.notes !== undefined) attributes.notes = { value: input.notes, format: "plain_text" };
    if (input.timestamp !== undefined) attributes.timestamp = toUnix(input.timestamp);
    if (!Object.keys(attributes).length) throw new Error("update_log needs at least one field to change");
    return this.patchResource("log", input.bundle, input.id, attributes);
  }

  async createRecord(
    input: RecordInput,
    extraAttributes: Record<string, unknown> = {},
  ): Promise<RecordSummary> {
    assertWrites(this.config);
    assertWritableEntity(input.entity);
    const attributes = { ...plainAttributes(input.attributes), ...extraAttributes };
    const relationships = relationshipMap(input.relationships);
    return this.postResource(input.entity, input.bundle, attributes, relationships);
  }

  async updateRecord(input: RecordPatch): Promise<RecordSummary> {
    assertWrites(this.config);
    assertWritableEntity(input.entity);
    const attributes = plainAttributes(input.attributes);
    const relationships = relationshipMap(input.relationships);
    if (!Object.keys(attributes).length && !Object.keys(relationships).length) {
      throw new Error("update_record needs attributes or relationships");
    }
    return this.patchResource(input.entity, input.bundle, input.id, attributes, relationships);
  }

  /** Used by the smoke test to remove records it created. Not exposed as a tool. */
  async deleteRecord(entity: string, bundle: string, id: string): Promise<void> {
    if (!this.config.allowDelete) {
      throw new Error("Deletes are disabled. Set FARMOS_ALLOW_DELETE=true.");
    }
    assertWritableEntity(entity);
    await this.request("DELETE", `/api/${entity}/${bundle}/${id}`);
  }

  private async listAcross(
    entity: string,
    bundle: string | undefined,
    query: FilterInput & { sort?: string },
  ): Promise<ListResult> {
    const types = (await this.resourceTypes()).filter((type) => {
      return type.entity === entity && (!bundle || type.bundle === bundle);
    });
    if (!types.length) {
      const message = bundle
        ? `No ${entity} bundle named ${bundle}`
        : `No ${entity} bundles on this farmOS`;
      return { records: [], truncated: false, warnings: [message] };
    }
    const warnings: string[] = [];
    const records: RecordSummary[] = [];
    let truncated = false;
    const limit = cap(query.limit);
    for (const type of types) {
      if (records.length >= limit) {
        truncated = true;
        break;
      }
      try {
        const page = await this.collection(type.entity, type.bundle, filters({
          ...query,
          limit: limit - records.length,
        }));
        records.push(...page.records);
        truncated = truncated || page.truncated;
      } catch (err) {
        warnings.push(`${type.type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { records: records.slice(0, limit), truncated, warnings };
  }

  private async collection(
    entity: string,
    bundle: string,
    query: Record<string, string>,
  ): Promise<{ records: RecordSummary[]; truncated: boolean }> {
    const params = new URLSearchParams(query);
    const path = `/api/${entity}/${bundle}?${params.toString()}`;
    const doc = await this.getJson(path);
    const data = Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : [];
    const next = doc.links?.next;
    return {
      records: data.map((resource) => summarizeRecord(resource)),
      truncated: Boolean(next),
    };
  }

  private async postResource(
    entity: string,
    bundle: string,
    attributes: Record<string, unknown>,
    relationships: Record<string, { data: ResourceRef | ResourceRef[] }>,
  ): Promise<RecordSummary> {
    const body: Record<string, unknown> = {
      data: {
        type: `${entity}--${bundle}`,
        attributes,
        ...(Object.keys(relationships).length ? { relationships } : {}),
      },
    };
    const doc = await this.sendJson("POST", `/api/${entity}/${bundle}`, body);
    const data = one(doc);
    if (!data?.id) throw new Error(`farmOS did not return a ${entity}--${bundle} record`);
    return summarizeRecord(data);
  }

  private async patchResource(
    entity: string,
    bundle: string,
    id: string,
    attributes: Record<string, unknown>,
    relationships: Record<string, { data: ResourceRef | ResourceRef[] }> = {},
  ): Promise<RecordSummary> {
    const data: Record<string, unknown> = {
      type: `${entity}--${bundle}`,
      id,
    };
    if (Object.keys(attributes).length) data.attributes = attributes;
    if (Object.keys(relationships).length) data.relationships = relationships;
    const doc = await this.sendJson("PATCH", `/api/${entity}/${bundle}/${id}`, { data });
    const resource = one(doc);
    if (!resource?.id) throw new Error(`farmOS did not return ${entity}/${bundle}/${id}`);
    return summarizeRecord(resource);
  }

  private async getJson(path: string): Promise<JsonApiDocument> {
    return this.sendJson("GET", path);
  }

  private async sendJson(method: string, path: string, body?: unknown): Promise<JsonApiDocument> {
    const response = await this.request(method, path, body);
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as JsonApiDocument;
    } catch {
      throw new Error(`farmOS returned non-JSON (${response.status})`);
    }
  }

  private async fetchChecked(url: URL, init: RequestInit, hops = 0): Promise<Response> {
    const response = await this.fetchImpl(url, { ...init, redirect: "manual" });
    if (hops < 3 && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return response;
      const next = resolveFarmUrl(baseUrl(this.config), location);
      const method = response.status === 303 ? "GET" : (init.method || "GET");
      return this.fetchChecked(next, {
        ...init,
        method,
        body: method === "GET" ? undefined : init.body,
      }, hops + 1);
    }
    return response;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = resolveFarmUrl(baseUrl(this.config), path);
    const headers = new Headers({
      Authorization: `Bearer ${await this.accessToken()}`,
      Accept: "application/vnd.api+json",
    });
    let payload: string | undefined;
    if (body !== undefined) {
      headers.set("Content-Type", "application/vnd.api+json");
      payload = JSON.stringify(body);
    }
    const response = await this.fetchChecked(url, { method, headers, body: payload });
    if (response.status === 401 && this.token) {
      this.token = undefined;
      headers.set("Authorization", `Bearer ${await this.accessToken()}`);
      const retried = await this.fetchChecked(url, { method, headers, body: payload });
      if (retried.ok || retried.status === 204) return retried;
      throw await farmError(retried);
    }
    if (!response.ok && response.status !== 204) throw await farmError(response);
    return response;
  }

  private async accessToken(): Promise<string> {
    if (this.actor) return this.actor.getAccessToken();
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    this.tokenFlight ??= this.fetchAccessToken().finally(() => {
      this.tokenFlight = undefined;
    });
    return this.tokenFlight;
  }

  private async fetchAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const url = resolveFarmUrl(baseUrl(this.config), "/oauth/token");
    const form = new URLSearchParams();
    form.set("scope", this.config.scope);
    if (this.config.username && this.config.password) {
      form.set("grant_type", "password");
      form.set("client_id", "farm");
      form.set("username", this.config.username);
      form.set("password", this.config.password);
    } else {
      form.set("grant_type", "client_credentials");
      form.set("client_id", this.config.clientId);
      form.set("client_secret", this.config.clientSecret || "");
    }
    const response = await this.fetchChecked(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "farmos-mcp",
      },
      body: form.toString(),
    });
    const payload = await response.json().catch(() => ({})) as {
      access_token?: string;
      expires_in?: number | string;
      error?: string;
      error_description?: string;
      message?: string;
    };
    if (!response.ok || !payload.access_token) {
      const detail = payload.error_description || payload.message || payload.error || response.statusText;
      throw new Error(`farmOS login failed (${response.status}): ${detail}`);
    }
    const expiresIn = Number(payload.expires_in || 300);
    this.token = {
      value: payload.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return payload.access_token;
  }
}

export async function loginWithPassword(
  config: FarmConfig,
  username: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FarmSession> {
  const token = await requestFarmToken(config, fetchImpl, {
    grant_type: "password",
    client_id: "farm",
    username,
    password,
    scope: "farm_manager",
  });
  return { username, ...token };
}

export async function refreshFarmSession(
  config: FarmConfig,
  session: FarmSession,
  fetchImpl: typeof fetch = fetch,
): Promise<FarmSession> {
  if (!session.refreshToken) throw new Error("Sign in to farmOS again");
  const token = await requestFarmToken(config, fetchImpl, {
    grant_type: "refresh_token",
    client_id: "farm",
    refresh_token: session.refreshToken,
  });
  return { username: session.username, ...token, refreshToken: token.refreshToken ?? session.refreshToken };
}

async function requestFarmToken(
  config: FarmConfig,
  fetchImpl: typeof fetch,
  fields: Record<string, string>,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }> {
  const url = resolveFarmUrl(baseUrl(config), "/oauth/token");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "farmos-mcp",
    },
    body: new URLSearchParams(fields),
  });
  const payload = await response.json().catch(() => ({})) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number | string;
    error_description?: string;
    error?: string;
    message?: string;
  };
  if (!response.ok || !payload.access_token) {
    const detail = payload.error_description || payload.message || payload.error || response.statusText;
    throw new Error(`farmOS login failed (${response.status}): ${detail}`);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + Number(payload.expires_in || 300) * 1000,
  };
}

interface FilterInput {
  name?: string;
  status?: string;
  archived?: boolean;
  assetId?: string;
  from?: string;
  to?: string;
  limit?: number;
  sort?: string;
}

function filters(input: FilterInput): Record<string, string> {
  const query: Record<string, string> = {};
  if (input.limit) query["page[limit]"] = String(input.limit);
  if (input.sort) query.sort = input.sort;
  if (input.status) query["filter[status][value]"] = input.status;
  if (input.archived !== undefined) query["filter[archived][value]"] = input.archived ? "1" : "0";
  if (input.name) {
    query["filter[name][condition][path]"] = "name";
    query["filter[name][condition][operator]"] = "CONTAINS";
    query["filter[name][condition][value]"] = input.name;
  }
  if (input.assetId) {
    query["filter[asset][condition][path]"] = "asset.id";
    query["filter[asset][condition][value]"] = input.assetId;
  }
  if (input.from) {
    query["filter[from][condition][path]"] = "timestamp";
    query["filter[from][condition][operator]"] = ">=";
    query["filter[from][condition][value]"] = String(toUnix(input.from));
  }
  if (input.to) {
    query["filter[to][condition][path]"] = "timestamp";
    query["filter[to][condition][operator]"] = "<=";
    query["filter[to][condition][value]"] = String(toUnix(input.to));
  }
  return query;
}

function cap(limit: number | undefined): number {
  if (!limit) return 20;
  return Math.min(Math.max(Math.floor(limit), 1), 50);
}

function one(doc: JsonApiDocument): JsonApiResource | undefined {
  if (Array.isArray(doc.data)) return doc.data[0];
  return doc.data;
}

function plainAttributes(
  attributes: Record<string, string | number | boolean | null> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (key === "notes" && typeof value === "string") {
      out.notes = { value, format: "plain_text" };
      continue;
    }
    if (key === "timestamp" && (typeof value === "string" || typeof value === "number")) {
      out.timestamp = toUnix(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function relationshipMap(
  relationships: { field: string; refs: ResourceRef[] }[] | undefined,
): Record<string, { data: ResourceRef | ResourceRef[] }> {
  const out: Record<string, { data: ResourceRef | ResourceRef[] }> = {};
  for (const relationship of relationships ?? []) {
    if (!relationship.refs.length) continue;
    out[relationship.field] = {
      data: relationship.refs.length === 1 ? relationship.refs[0] : relationship.refs,
    };
  }
  return out;
}

async function farmError(response: Response): Promise<Error> {
  const text = await response.text();
  try {
    const doc = JSON.parse(text) as JsonApiDocument;
    const error = doc.errors?.[0];
    if (error) {
      return new Error(`farmOS ${error.status || response.status} ${error.title || ""}: ${error.detail || text}`.trim());
    }
  } catch {
    // fall through
  }
  return new Error(`farmOS ${response.status}: ${text.slice(0, 300) || response.statusText}`);
}
