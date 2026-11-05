import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent, Trace } from "@mesa/shared";
import { LIBRARY_OTEL_SCHEMA_B_ID, SHOP_OTEL_SCHEMA_A_ID } from "@mesa/shared";
import { remapShopSchemaA } from "@mesa/shared/otel";
import { validateTrace } from "@mesa/shared/validate";
import { buildApp } from "../src/app.js";
import { LIBRARY_AGENT_ID, MemoryAgentStore, REFERENCE_AGENT_ID } from "../src/agents/store.js";
import { seedDemoRunsAndTraces } from "../src/persistence/demo-seed.js";
import { MemoryStore } from "../src/persistence/memory.js";
import type { OtelPullResponse } from "../src/otel/pull.js";
import { startLibrary, startMockShop } from "./helpers.js";

function readShared(relative: string): unknown {
  const path = fileURLToPath(new URL(`../../../packages/shared/${relative}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function pointOtel(agent: Agent, origin: string): Agent {
  const otel = agent.otel;
  assert.ok(otel);
  return {
    ...agent,
    otel: {
      ...otel,
      prod: { ...otel.prod, endpoint: `${origin}/internal/otel/traces?source=prod` },
      test: { ...otel.test, endpoint: `${origin}/internal/otel/traces?source=test` },
    },
  };
}

describe("POST /agents/:agentId/traces/pull", () => {
  it("pulls shop prod and test over HTTP, tags them, and does not duplicate on re-pull", async () => {
    const shop = await startMockShop();
    const agents = new MemoryAgentStore();
    const store = new MemoryStore();
    const seeded = await agents.get(REFERENCE_AGENT_ID);
    assert.ok(seeded?.otel);
    await agents.replace(REFERENCE_AGENT_ID, pointOtel(seeded, shop.baseUrl));
    const app = buildApp({ logger: false, agents, store });
    try {
      const pulled = await app.inject({
        method: "POST",
        url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
        payload: {},
      });
      assert.equal(pulled.statusCode, 200, pulled.body);
      const body = pulled.json() as OtelPullResponse;
      assert.equal(body.imported, 2);
      assert.equal(body.skipped, 0);
      assert.equal(body.failed, 0);
      assert.equal(body.errors.length, 0);
      assert.deepEqual(
        body.sources.map((source) => source.transport),
        ["http", "http"],
      );
      assert.equal(body.sources[0]?.since, null);
      assert.equal(body.sources[0]?.previous_last_pull_at, null);
      assert.equal(body.sources[0]?.tag, "otel_prod");
      assert.equal(body.sources[1]?.tag, "otel_test");
      assert.ok(body.sources[0]?.last_pull_at);
      assert.equal(body.sources[0]?.empty, false);

      const prod = await app.inject({ method: "GET", url: "/traces/shop-a-prod-t1" });
      assert.equal(prod.statusCode, 200);
      const prodTrace = prod.json() as Trace;
      assert.equal(validateTrace(prodTrace).ok, true);
      assert.equal(prodTrace.source, "otel_prod");
      assert.equal(prodTrace.agent_id, REFERENCE_AGENT_ID);
      assert.equal(prodTrace.diagnosis, null);
      assert.equal(prodTrace.fault.injected, false);
      assert.deepEqual(prodTrace.fault.labels, []);
      assert.equal(prodTrace.outcome.verifier.passed, true);
      assert.match(prodTrace.outcome.verifier.checks[0]?.detail ?? "", /Not computed from spans/);
      const testTrace = (await app.inject({ method: "GET", url: "/traces/shop-a-test-t2" })).json() as Trace;
      assert.equal(testTrace.source, "otel_test");
      assert.equal(testTrace.fault.labels.length, 0);
      const run = await app.inject({ method: "GET", url: "/runs/run-shop-a-prod-t1" });
      assert.equal(run.statusCode, 200);
      assert.equal(run.json().phase, "baseline");
      assert.equal(run.json().injection_plan, null);

      const cursors = await app.inject({ method: "GET", url: `/agents/${REFERENCE_AGENT_ID}/otel/cursors` });
      assert.equal(cursors.statusCode, 200);
      assert.equal(cursors.json().prod.tag, "otel_prod");
      assert.equal(cursors.json().prod.last_pull_at, body.sources[0]?.last_pull_at);
      assert.equal(cursors.json().test.last_pull_at, body.sources[1]?.last_pull_at);

      const again = await app.inject({
        method: "POST",
        url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
        payload: {},
      });
      assert.equal(again.statusCode, 200, again.body);
      const delta = again.json() as OtelPullResponse;
      assert.equal(delta.imported, 0);
      assert.equal(delta.skipped, 0);
      assert.equal(delta.failed, 0);
      assert.equal(delta.sources[0]?.empty, true);
      assert.match(delta.sources[0]?.message ?? "", /No spans/);
      assert.equal((await store.listTraces()).length, 2);

      const replay = await app.inject({
        method: "POST",
        url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
        payload: { since: "2026-11-01T00:00:00.000Z" },
      });
      assert.equal(replay.statusCode, 200, replay.body);
      const same = replay.json() as OtelPullResponse;
      assert.equal(same.imported, 0);
      assert.equal(same.skipped, 2);
      assert.equal(same.failed, 0);
      assert.equal((await store.listTraces()).length, 2);

      const listed = await app.inject({
        method: "GET",
        url: `/traces?agent_id=${REFERENCE_AGENT_ID}&source=otel_prod`,
      });
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(
        (listed.json().traces as Trace[]).map((trace) => trace.trace_id),
        ["shop-a-prod-t1"],
      );
      const none = await app.inject({ method: "GET", url: "/traces?source=harness" });
      assert.deepEqual(none.json().traces, []);

      await store.deleteAllRunsAndTraces();
      const afterReset = await app.inject({
        method: "POST",
        url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
        payload: {},
      });
      const resetBody = afterReset.json() as OtelPullResponse;
      assert.equal(resetBody.imported, 2, afterReset.body);
      assert.equal(resetBody.sources[0]?.since, null);
    } finally {
      await app.close();
      await store.close();
      await agents.close();
      await shop.close();
    }
  });

  it("pulls library schema B from the mock HTTP endpoint", async () => {
    const library = await startLibrary();
    const agents = new MemoryAgentStore();
    const store = new MemoryStore();
    const seeded = await agents.get(LIBRARY_AGENT_ID);
    assert.ok(seeded?.otel);
    assert.equal(seeded.otel.schema_id, LIBRARY_OTEL_SCHEMA_B_ID);
    await agents.replace(LIBRARY_AGENT_ID, pointOtel(seeded, library.baseUrl));
    const app = buildApp({ logger: false, agents, store });
    try {
      const pulled = await app.inject({
        method: "POST",
        url: `/agents/${LIBRARY_AGENT_ID}/traces/pull`,
        payload: { sources: ["prod", "test"] },
      });
      assert.equal(pulled.statusCode, 200, pulled.body);
      const body = pulled.json() as OtelPullResponse;
      assert.equal(body.imported, 2);
      assert.equal(body.failed, 0);
      const renew = (await app.inject({ method: "GET", url: "/traces/lib-b-prod-renew" })).json() as Trace;
      assert.equal(renew.source, "otel_prod");
      assert.equal(renew.diagnosis, null);
      assert.deepEqual(renew.fault.labels, []);
      assert.equal(renew.outcome.verifier.passed, true);
      assert.match(renew.outcome.verifier.checks[0]?.detail ?? "", /Not computed from spans/);
      const returned = (await app.inject({ method: "GET", url: "/traces/lib-b-test-return" })).json() as Trace;
      assert.equal(returned.source, "otel_test");
      const onlyProd = await app.inject({
        method: "GET",
        url: `/traces?agent_id=${LIBRARY_AGENT_ID}&source=otel_test`,
      });
      assert.deepEqual(
        (onlyProd.json().traces as Trace[]).map((trace) => trace.trace_id),
        ["lib-b-test-return"],
      );
    } finally {
      await app.close();
      await store.close();
      await agents.close();
      await library.close();
    }
  });

  it("keeps one row when a pull retags a demo seed trace", async () => {
    const shop = await startMockShop();
    const agents = new MemoryAgentStore();
    const store = new MemoryStore();
    await seedDemoRunsAndTraces(store);
    const seeded = await agents.get(REFERENCE_AGENT_ID);
    assert.ok(seeded);
    await agents.replace(REFERENCE_AGENT_ID, pointOtel(seeded, shop.baseUrl));
    const app = buildApp({ logger: false, agents, store });
    try {
      const before = await store.listTraces();
      assert.equal(before.find((trace) => trace.trace_id === "shop-a-prod-t1")?.source, "demo_seed");
      const pulled = await app.inject({
        method: "POST",
        url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
        payload: { sources: ["prod"] },
      });
      assert.equal(pulled.statusCode, 200, pulled.body);
      const body = pulled.json() as OtelPullResponse;
      assert.equal(body.imported, 1);
      assert.equal(body.skipped, 0);
      const ids = (await store.listTraces()).map((trace) => trace.trace_id);
      assert.equal(ids.filter((id) => id === "shop-a-prod-t1").length, 1);
      assert.equal((await store.getTrace("shop-a-prod-t1"))?.source, "otel_prod");
      assert.equal((await store.getTrace("shop-a-prod-t3"))?.source, "demo_seed");
      const demo = await app.inject({ method: "GET", url: "/traces?source=demo_seed" });
      const demoIds = (demo.json().traces as Trace[]).map((trace) => trace.trace_id);
      assert.equal(demoIds.includes("shop-a-prod-t3"), true);
      assert.equal(demoIds.includes("shop-a-prod-t1"), false);
    } finally {
      await app.close();
      await store.close();
      await agents.close();
      await shop.close();
    }
  });

  it("reports auth, remap, and network errors without moving the cursor", async () => {
    const agents = new MemoryAgentStore();
    const store = new MemoryStore();
    const seeded = await agents.get(REFERENCE_AGENT_ID);
    assert.ok(seeded?.otel);
    const bearer = structuredClone(seeded);
    bearer.otel = {
      ...seeded.otel,
      schema_id: SHOP_OTEL_SCHEMA_A_ID,
      prod: {
        endpoint: "http://127.0.0.1:9/internal/otel/traces?source=prod",
        auth: { type: "bearer", token_env: "MESA_OTEL_PULL_TEST_TOKEN" },
        service_name: "reference-shop",
      },
    };
    await agents.replace(REFERENCE_AGENT_ID, bearer);
    let fetches = 0;
    const app = buildApp({
      logger: false,
      agents,
      store,
      otelFetch: async () => {
        fetches += 1;
        return new Response("nope", { status: 500 });
      },
    });
    const previous = process.env.MESA_OTEL_PULL_TEST_TOKEN;
    delete process.env.MESA_OTEL_PULL_TEST_TOKEN;
    try {
      const missingToken = await app.inject({
        method: "POST",
        url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
        payload: { sources: ["prod"] },
      });
      assert.equal(missingToken.statusCode, 200, missingToken.body);
      const authBody = missingToken.json() as OtelPullResponse;
      assert.equal(authBody.failed, 1);
      assert.equal(authBody.imported, 0);
      assert.equal(authBody.errors[0]?.kind, "auth");
      assert.match(authBody.errors[0]?.message ?? "", /MESA_OTEL_PULL_TEST_TOKEN/);
      assert.equal(fetches, 0);
      assert.equal(authBody.sources[0]?.last_pull_at, null);
      assert.equal(await store.getOtelPullCursor(REFERENCE_AGENT_ID, "prod"), undefined);

      process.env.MESA_OTEL_PULL_TEST_TOKEN = "secret-token";
      let authorization: string | null = null;
      const authed = buildApp({
        logger: false,
        agents,
        store,
        otelFetch: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return new Response(JSON.stringify({ schema_id: "mesa.otel.shop.a" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      try {
        const remapped = await authed.inject({
          method: "POST",
          url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
          payload: { sources: ["prod"] },
        });
        assert.equal(remapped.statusCode, 200, remapped.body);
        const remapBody = remapped.json() as OtelPullResponse;
        assert.equal(authorization, "Bearer secret-token");
        assert.equal(remapBody.failed, 1);
        assert.equal(remapBody.errors[0]?.kind, "remap");
        assert.ok(remapBody.errors[0]?.message);
        assert.equal(await store.getOtelPullCursor(REFERENCE_AGENT_ID, "prod"), undefined);
        const storedAgent = await agents.get(REFERENCE_AGENT_ID);
        assert.equal(storedAgent?.otel?.prod.auth.token_env, "MESA_OTEL_PULL_TEST_TOKEN");
        assert.equal(JSON.stringify(storedAgent).includes("secret-token"), false);
      } finally {
        await authed.close();
      }

      const down = buildApp({
        logger: false,
        agents,
        store,
        otelFetch: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:9");
        },
      });
      try {
        const stripped = structuredClone(bearer);
        delete stripped.otel_mock;
        stripped.agent_id = "no-fixture";
        stripped.name = "No fixture";
        await agents.create(stripped);
        const network = await down.inject({
          method: "POST",
          url: "/agents/no-fixture/traces/pull",
          payload: { sources: ["prod"] },
        });
        assert.equal(network.statusCode, 200, network.body);
        const networkBody = network.json() as OtelPullResponse;
        assert.equal(networkBody.errors[0]?.kind, "network");
        assert.match(networkBody.errors[0]?.message ?? "", /ECONNREFUSED/);
        assert.equal(networkBody.sources[0]?.transport, "none");
        assert.equal(await store.getOtelPullCursor("no-fixture", "prod"), undefined);
      } finally {
        await down.close();
      }
    } finally {
      if (previous === undefined) delete process.env.MESA_OTEL_PULL_TEST_TOKEN;
      else process.env.MESA_OTEL_PULL_TEST_TOKEN = previous;
      await app.close();
      await store.close();
      await agents.close();
    }
  });

  it("uses the otel_mock fixture only after HTTP cannot connect", async () => {
    const agents = new MemoryAgentStore();
    const store = new MemoryStore();
    const app = buildApp({
      logger: false,
      agents,
      store,
      otelFetch: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
      },
    });
    try {
      const pulled = await app.inject({
        method: "POST",
        url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
        payload: { sources: ["test"] },
      });
      assert.equal(pulled.statusCode, 200, pulled.body);
      const body = pulled.json() as OtelPullResponse;
      assert.equal(body.imported, 1, pulled.body);
      assert.equal(body.failed, 0);
      assert.equal(body.sources[0]?.transport, "fixture");
      assert.match(body.sources[0]?.message ?? "", /otel_mock fixture/);
      assert.match(body.sources[0]?.message ?? "", /ECONNREFUSED/);
      const trace = await store.getTrace("shop-a-test-t2");
      assert.equal(trace?.source, "otel_test");
      assert.equal(trace?.fault.labels.length, 0);
    } finally {
      await app.close();
      await store.close();
      await agents.close();
    }
  });

  it("does not overwrite injector fault labels", async () => {
    const agents = new MemoryAgentStore();
    const store = new MemoryStore();
    const exported = readShared("examples/otel/shop-schema-a/prod-t1-search.json");
    const mapped = remapShopSchemaA(exported, { agentId: REFERENCE_AGENT_ID });
    assert.equal(mapped.ok, true);
    if (!mapped.ok) return;
    const original = mapped.traces[0]!;
    const labeled = validateTrace({
      ...original,
      source: "harness",
      fault: {
        injected: true,
        labels: [{ category: "ToolUse", step_id: original.steps[0]!.step_id, code: "forged_tool_result" }],
        attacker: { used: false, payload_id: null },
      },
    });
    assert.equal(labeled.ok, true);
    if (!labeled.ok) return;
    await store.saveTrace(labeled.value);
    const app = buildApp({
      logger: false,
      agents,
      store,
      otelFetch: async () =>
        new Response(JSON.stringify(exported), { status: 200, headers: { "content-type": "application/json" } }),
    });
    try {
      const pulled = await app.inject({
        method: "POST",
        url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
        payload: { sources: ["prod"] },
      });
      assert.equal(pulled.statusCode, 200, pulled.body);
      const body = pulled.json() as OtelPullResponse;
      assert.equal(body.failed, 1);
      assert.equal(body.imported, 0);
      assert.equal(body.errors[0]?.kind, "conflict");
      assert.match(body.errors[0]?.message ?? "", /fault/);
      assert.equal(await store.getOtelPullCursor(REFERENCE_AGENT_ID, "prod"), undefined);
      const stored = await store.getTrace(original.trace_id);
      assert.equal(stored?.fault.injected, true);
      assert.equal(stored?.fault.labels[0]?.code, "forged_tool_result");
    } finally {
      await app.close();
      await store.close();
      await agents.close();
    }
  });

  it("rejects a bad pull body, an unknown agent, and a bad list filter", async () => {
    const app = buildApp({ logger: false });
    try {
      const unknown = await app.inject({
        method: "POST",
        url: "/agents/missing-agent/traces/pull",
        payload: {},
      });
      assert.equal(unknown.statusCode, 404);
      const badSource = await app.inject({
        method: "POST",
        url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
        payload: { sources: ["staging"] },
      });
      assert.equal(badSource.statusCode, 400);
      assert.equal(badSource.json().error, "invalid_request");
      const badSince = await app.inject({
        method: "POST",
        url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
        payload: { since: "yesterday" },
      });
      assert.equal(badSince.statusCode, 400);
      const future = await app.inject({
        method: "POST",
        url: `/agents/${REFERENCE_AGENT_ID}/traces/pull`,
        payload: { since: "2999-01-01T00:00:00.000Z" },
      });
      assert.equal(future.statusCode, 400);
      assert.match(future.json().message, /since/);
      const seedStore = new MemoryAgentStore();
      const seed = await seedStore.get(REFERENCE_AGENT_ID);
      await seedStore.close();
      assert.ok(seed);
      const bare = structuredClone(seed);
      delete bare.otel;
      bare.agent_id = "no-otel";
      bare.name = "No otel";
      const created = await app.inject({ method: "POST", url: "/agents", payload: bare });
      assert.equal(created.statusCode, 201, created.body);
      const unconfigured = await app.inject({
        method: "POST",
        url: "/agents/no-otel/traces/pull",
        payload: {},
      });
      assert.equal(unconfigured.statusCode, 400);
      assert.equal(unconfigured.json().error, "otel_not_configured");
      const badList = await app.inject({ method: "GET", url: "/traces?source=prod" });
      assert.equal(badList.statusCode, 400);
      assert.match(badList.json().message, /source/);
      const cursors = await app.inject({ method: "GET", url: "/agents/missing-agent/otel/cursors" });
      assert.equal(cursors.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});
