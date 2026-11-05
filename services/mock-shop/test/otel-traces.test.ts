import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { MOCK_OTEL_SCHEMA_HEADER, MOCK_OTEL_SCHEMA_VALUE } from "../src/otel-exports.js";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/shared/examples/otel/shop-schema-a",
);

function seed(name: string): { spans: Array<{ opened_ms: number }>; schema_id: string } {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as {
    spans: Array<{ opened_ms: number }>;
    schema_id: string;
  };
}

describe("GET /internal/otel/traces", () => {
  it("returns the prod seed by default and does not touch world state", async () => {
    const app = buildApp();
    try {
      const before = await app.inject({ method: "GET", url: "/internal/state" });
      const pulled = await app.inject({ method: "GET", url: "/internal/otel/traces" });
      const after = await app.inject({ method: "GET", url: "/internal/state" });
      assert.equal(pulled.statusCode, 200);
      assert.equal(pulled.headers[MOCK_OTEL_SCHEMA_HEADER.toLowerCase()], MOCK_OTEL_SCHEMA_VALUE);
      const body = pulled.json();
      assert.equal(body.schema_id, "mesa.otel.shop.a");
      assert.equal(body.shop_export.channel, "prod");
      assert.deepEqual(body, seed("prod-t1-search.json"));
      assert.deepEqual(after.json().carts, before.json().carts);
      assert.deepEqual(after.json().orders, before.json().orders);
    } finally {
      await app.close();
    }
  });

  it("returns the test seed when source=test", async () => {
    const app = buildApp();
    try {
      const pulled = await app.inject({ method: "GET", url: "/internal/otel/traces?source=test" });
      assert.equal(pulled.statusCode, 200);
      assert.deepEqual(pulled.json(), seed("test-t2-cart.json"));
    } finally {
      await app.close();
    }
  });

  it("filters spans on since and rejects a bad query", async () => {
    const app = buildApp();
    try {
      const prod = seed("prod-t1-search.json");
      const cutoff = new Date(prod.spans[1]!.opened_ms).toISOString();
      const filtered = await app.inject({
        method: "GET",
        url: `/internal/otel/traces?source=prod&since=${encodeURIComponent(cutoff)}`,
      });
      assert.equal(filtered.statusCode, 200);
      assert.equal(filtered.json().spans.length, 2);

      const empty = await app.inject({
        method: "GET",
        url: `/internal/otel/traces?since=${encodeURIComponent("2099-01-01T00:00:00.000Z")}`,
      });
      assert.equal(empty.statusCode, 200);
      assert.equal(empty.json().spans.length, 0);
      assert.equal(empty.json().shop_export.task, "T1");

      const badSource = await app.inject({ method: "GET", url: "/internal/otel/traces?source=staging" });
      assert.equal(badSource.statusCode, 400);
      assert.equal(badSource.json().error, "invalid_request");

      const badSince = await app.inject({ method: "GET", url: "/internal/otel/traces?since=yesterday" });
      assert.equal(badSince.statusCode, 400);
      assert.equal(badSince.json().error, "invalid_request");
    } finally {
      await app.close();
    }
  });
});
