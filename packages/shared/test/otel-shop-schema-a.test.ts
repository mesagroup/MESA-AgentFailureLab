import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SHOP_OTEL_SCHEMA_A_ID, type Agent } from "../src/index.js";
import { mapOtelImport } from "../src/otel-import.js";
import { pullShopOtelMock, readShopOtelMock, remapShopSchemaA } from "../src/otel-shop-schema-a.js";
import { validateAgent, validateTrace } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("shop schema A mock pull", () => {
  const prodT1 = readJson("examples/otel/shop-schema-a/prod-t1-search.json");
  const prodT3 = readJson("examples/otel/shop-schema-a/prod-t3-checkout.json");

  it("maps the prod T1 fixture onto a validated trace without inventing a verdict or labels", () => {
    const result = remapShopSchemaA(prodT1, { agentId: "reference-shop" });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
    if (!result.ok) return;
    assert.equal(result.traces.length, 1);
    const trace = result.traces[0]!;
    assert.equal(validateTrace(trace).ok, true);
    assert.equal(trace.trace_id, "shop-a-prod-t1");
    assert.equal(trace.agent_id, "reference-shop");
    assert.equal(trace.task_id, "T1");
    assert.equal(trace.status, "completed");
    assert.equal(trace.outcome.success, true);
    assert.equal(trace.outcome.verifier.passed, true);
    assert.equal(trace.fault.injected, false);
    assert.deepEqual(trace.fault.labels, []);
    assert.equal(trace.fault.attacker.used, false);
    assert.equal(trace.diagnosis, null);
    assert.equal(trace.steps.length, 3);
  });

  it("maps the test T2 fixture through readShopOtelMock", () => {
    const agent = readJson("examples/agent-reference-shop.json") as Agent;
    assert.equal(agent.otel?.schema_id, SHOP_OTEL_SCHEMA_A_ID);
    assert.match(agent.otel?.prod.endpoint ?? "", /\/internal\/otel\/traces\?source=prod$/);
    assert.equal(agent.otel_mock?.schema_id, SHOP_OTEL_SCHEMA_A_ID);
    assert.equal(
      agent.otel_mock?.sources.test.fixture_path,
      "packages/shared/examples/otel/shop-schema-a/test-t2-cart.json",
    );
    const batch = readShopOtelMock("test");
    const result = remapShopSchemaA(batch, { agentId: "reference-shop" });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
    if (!result.ok) return;
    assert.equal(result.traces[0]?.task_id, "T2");
    assert.equal(validateTrace(result.traces[0]).ok, true);
  });

  it("maps the prod T3 checkout export", () => {
    const result = remapShopSchemaA(prodT3, { agentId: "reference-shop" });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
    if (!result.ok) return;
    assert.equal(result.traces[0]?.task_id, "T3");
    assert.equal(validateTrace(result.traces[0]).ok, true);
  });

  it("rejects schema B with an explicit schema_id error", () => {
    const wrong = clone(prodT1) as { schema_id: string };
    wrong.schema_id = "mesa.otel.library.b";
    const result = remapShopSchemaA(wrong, { agentId: "reference-shop" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors.join(" "), "schema_id mesa.otel.library.b is not mesa.otel.shop.a");
  });

  it("is rejected by the generic mapper", () => {
    const result = mapOtelImport(prodT1, { agentId: "reference-shop" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.length > 0);
  });

  it("rejects a missing shop_export", () => {
    const missing = clone(prodT1) as { shop_export?: unknown };
    delete missing.shop_export;
    const result = remapShopSchemaA(missing, { agentId: "reference-shop" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join(" "), /shop_export/);
  });

  it("rejects a shop.fault.labels attribute", () => {
    const poisoned = clone(prodT1) as {
      spans: Array<{ shop_attrs: Record<string, unknown> }>;
    };
    poisoned.spans[0]!.shop_attrs["shop.fault.labels"] = [{ category: "ToolUse" }];
    const result = remapShopSchemaA(poisoned, { agentId: "reference-shop" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.length > 0);
  });

  it("accepts the shop seed with otel HTTP sources and fixture fallback", () => {
    const shop = readJson("examples/agent-reference-shop.json") as Agent;
    const library = readJson("examples/agent-library-desk.json") as Agent;
    const shopResult = validateAgent(shop);
    const libraryResult = validateAgent(library);
    assert.equal(shopResult.ok, true, shopResult.ok ? "" : shopResult.errors.join("; "));
    assert.equal(libraryResult.ok, true, libraryResult.ok ? "" : libraryResult.errors.join("; "));
    assert.equal(shop.otel?.prod.auth.type, "none");
    assert.equal(shop.otel_mock?.mode, "fixture");
    assert.equal(shop.otel_mock?.schema_id, SHOP_OTEL_SCHEMA_A_ID);
    assert.equal(library.otel?.schema_id, "mesa.otel.library.b");
    assert.equal(library.otel_mock?.schema_id, "mesa.otel.library.b");
  });

  it("pulls prod over HTTP and remaps without inventing a verdict", async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/internal/otel/traces" || url.searchParams.get("source") !== "prod") {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(prodT1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const batch = await pullShopOtelMock("prod", { origin: `http://127.0.0.1:${address.port}` });
      const result = remapShopSchemaA(batch, { agentId: "reference-shop" });
      assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
      if (!result.ok) return;
      assert.equal(validateTrace(result.traces[0]).ok, true);
      assert.equal(result.traces[0]?.fault.injected, false);
      assert.deepEqual(result.traces[0]?.fault.labels, []);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
