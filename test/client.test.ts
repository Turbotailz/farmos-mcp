import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FarmClient } from "../src/client.js";
import { assertBaseUrl, loadConfig, resolveFarmUrl, type FarmConfig } from "../src/config.js";
import { singleFlight } from "../src/single-flight.js";
import { toFraction } from "../src/summarize.js";

const baseConfig: FarmConfig = {
  url: "https://farm.example.com",
  clientId: "farmos-mcp",
  clientSecret: "secret",
  scope: "farm_worker",
  allowWrites: false,
  allowDelete: false,
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("config", () => {
  it("rejects a remote http farm URL", () => {
    assert.throws(() => assertBaseUrl("http://farm.example.com"), /https/);
  });

  it("allows localhost http and rewrites same-host http links onto https", () => {
    assert.equal(assertBaseUrl("http://127.0.0.1:8083").origin, "http://127.0.0.1:8083");
    const base = assertBaseUrl("https://farm.example.com");
    const next = resolveFarmUrl(base, "http://farm.example.com/api/asset/equipment");
    assert.equal(next.href, "https://farm.example.com/api/asset/equipment");
  });

  it("refuses links to another host", () => {
    const base = assertBaseUrl("https://farm.example.com");
    assert.throws(() => resolveFarmUrl(base, "https://evil.example/api"), /evil\.example/);
  });

  it("loads client credentials from env", () => {
    const config = loadConfig({
      FARMOS_URL: "https://farm.example.com",
      FARMOS_CLIENT_SECRET: "s",
      FARMOS_ALLOW_WRITES: "true",
    });
    assert.equal(config.allowWrites, true);
    assert.equal(config.clientId, "farm");
    assert.equal(config.scope, "farm_worker");
  });
});

describe("FarmClient", () => {
  it("uses the client credentials grant and summarizes farm info", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method} ${url}`);
      if (url.endsWith("/oauth/token")) {
        const body = String(init?.body);
        assert.match(body, /grant_type=client_credentials/);
        assert.match(body, /client_secret=secret/);
        assert.doesNotMatch(body, /password=/);
        return json(200, { access_token: "token-1", expires_in: 3600 });
      }
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token-1");
      return json(200, {
        meta: { farm: { name: "Duns Law", version: "4.0.1", system_of_measurement: "metric" } },
        links: { "asset--equipment": { href: "http://farm.example.com/api/asset/equipment" } },
      });
    };
    const client = new FarmClient(baseConfig, fetchImpl);
    const info = await client.farmInfo();
    assert.equal(info.name, "Duns Law");
    assert.equal(info.allow_writes, false);
    const types = await client.resourceTypes();
    assert.equal(types[0]?.path, "/api/asset/equipment");
    assert.equal(calls.filter((call) => call.startsWith("POST")).length, 1);
  });

  it("refuses create_log when writes are off", async () => {
    const client = new FarmClient(baseConfig, async () => {
      throw new Error("should not be called");
    });
    await assert.rejects(
      () => client.createLog({ bundle: "observation", name: "Aphids" }),
      /FARMOS_ALLOW_WRITES/,
    );
  });

  it("posts a log with a fractional quantity", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) return json(200, { access_token: "t", expires_in: 3600 });
      bodies.push(JSON.parse(String(init?.body)));
      if (url.endsWith("/api/quantity/standard")) {
        return json(201, { data: { type: "quantity--standard", id: "11111111-1111-4111-8111-111111111111", attributes: { label: "drench" } } });
      }
      return json(201, {
        data: {
          type: "log--input",
          id: "22222222-2222-4222-8222-222222222222",
          attributes: { name: "Drench heifers", status: "done", timestamp: 1_700_000_000 },
        },
      });
    };
    const client = new FarmClient({ ...baseConfig, allowWrites: true }, fetchImpl);
    const created = await client.createLog({
      bundle: "input",
      name: "Drench heifers",
      quantity: { measure: "volume", value: 1.5, label: "drench" },
    });
    assert.equal(created.name, "Drench heifers");
    const quantity = bodies[0] as { data: { attributes: { value: { numerator: number; denominator: number } } } };
    assert.deepEqual(quantity.data.attributes.value, toFraction(1.5));
    const log = bodies[1] as { data: { relationships: { quantity: { data: { id: string }[] } } } };
    assert.equal(log.data.relationships.quantity.data[0]?.id, "11111111-1111-4111-8111-111111111111");
  });

  it("follows a same-host http redirect onto https", async () => {
    let hops = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) return json(200, { access_token: "t", expires_in: 3600 });
      hops += 1;
      if (hops === 1) {
        return new Response(null, { status: 302, headers: { location: "http://farm.example.com/api" } });
      }
      assert.equal(url, "https://farm.example.com/api");
      return json(200, { meta: { farm: { name: "Duns Law" } }, links: {} });
    };
    const client = new FarmClient(baseConfig, fetchImpl);
    const info = await client.farmInfo();
    assert.equal(info.name, "Duns Law");
  });

  it("returns an empty plan list when the farm has no plan types", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) return json(200, { access_token: "t", expires_in: 3600 });
      return json(200, {
        links: { "asset--land": { href: "https://farm.example.com/api/asset/land" } },
      });
    };
    const client = new FarmClient(baseConfig, fetchImpl);
    const plans = await client.listPlans({});
    assert.deepEqual(plans.records, []);
    assert.equal(plans.warnings.length, 1);
  });
});

describe("singleFlight", () => {
  it("runs one job when callers overlap", async () => {
    let started = 0;
    const first = singleFlight("refresh", async () => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "token";
    });
    const second = singleFlight("refresh", async () => {
      started += 1;
      return "other";
    });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, "token");
    assert.equal(b, "token");
    assert.equal(started, 1);
  });
});
