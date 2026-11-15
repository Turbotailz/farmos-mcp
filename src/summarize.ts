export interface ResourceRef {
  type: string;
  id: string;
}

export interface RecordSummary {
  id: string;
  entity: string;
  bundle: string;
  type: string;
  name?: string;
  status?: string;
  archived?: boolean;
  timestamp?: string;
  notes?: string;
  manufacturer?: string;
  model?: string;
  serial_number?: string;
  relationships?: Record<string, ResourceRef[]>;
}

interface JsonApiResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: ResourceRef | ResourceRef[] | null }>;
}

export function splitType(type: string): { entity: string; bundle: string } {
  const [entity, bundle] = type.split("--");
  return { entity: entity || type, bundle: bundle || "" };
}

function notesText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return clip(value);
  if (typeof value === "object" && value && "value" in value) {
    const text = (value as { value?: unknown }).value;
    if (typeof text === "string" && text.trim()) return clip(text);
  }
  return undefined;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
}

function refs(data: ResourceRef | ResourceRef[] | null | undefined): ResourceRef[] {
  if (!data) return [];
  const items = Array.isArray(data) ? data : [data];
  return items.filter((item) => item && typeof item.id === "string" && typeof item.type === "string");
}

export function summarizeRecord(resource: JsonApiResource): RecordSummary {
  const type = resource.type || "";
  const { entity, bundle } = splitType(type);
  const attributes = resource.attributes ?? {};
  const summary: RecordSummary = {
    id: resource.id || "",
    entity,
    bundle,
    type,
  };
  if (typeof attributes.name === "string") summary.name = attributes.name;
  if (typeof attributes.label === "string" && !summary.name) summary.name = attributes.label;
  if (typeof attributes.status === "string") summary.status = attributes.status;
  if (typeof attributes.archived === "boolean") summary.archived = attributes.archived;
  if (typeof attributes.timestamp === "number") {
    summary.timestamp = new Date(attributes.timestamp * 1000).toISOString();
  }
  const notes = notesText(attributes.notes);
  if (notes) summary.notes = notes;
  for (const key of ["manufacturer", "model", "serial_number"] as const) {
    const value = attributes[key];
    if (typeof value === "string" && value) summary[key] = value;
  }
  const relationships: Record<string, ResourceRef[]> = {};
  for (const [name, relation] of Object.entries(resource.relationships ?? {})) {
    const items = refs(relation?.data);
    if (items.length) relationships[name] = items.map((item) => ({ type: item.type, id: item.id }));
  }
  if (Object.keys(relationships).length) summary.relationships = relationships;
  return summary;
}

export function toFraction(value: number): { numerator: number; denominator: number } {
  if (!Number.isFinite(value)) throw new Error("Quantity value must be a finite number");
  const denominator = 1000;
  return { numerator: Math.round(value * denominator), denominator };
}

export function toUnix(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid timestamp: ${value}`);
  return Math.floor(parsed / 1000);
}
