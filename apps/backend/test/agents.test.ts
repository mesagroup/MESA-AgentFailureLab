import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TASK_EVALSET_VERSION, type Agent, type TaskEvalset } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";
import { openAgentStore, agentStoreKind } from "../src/agents/open.js";
import {
  isRenderPostgresUrl,
  listMigrationFiles,
  normalizeMigrationSql,
  postgresPoolConfig,
} from "../src/agents/postgres.js";
import { LIBRARY_AGENT_ID, MemoryAgentStore, REFERENCE_AGENT_ID } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import { loadLibraryAgent, loadReferenceAgent } from "../src/reference-agent.js";

function withoutServerFields(agent: Agent): Record<string, unknown> {
  const copy = structuredClone(agent) as unknown as Record<string, unknown>;
  delete copy.agent_id;
  delete copy.created_at;
  delete copy.updated_at;
  return copy;
}

function externalAgent(agentId: string, createdAt = "2020-01-01T00:00:00.000Z"): Agent {
  const agent = loadReferenceAgent();
  return {
    ...agent,
    agent_id: agentId,
    name: `External ${agentId}`,
    description: `Registered test agent ${agentId}.`,
    created_at: createdAt,
    updated_at: createdAt,
    instance: {
      kind: "external",
      base_url: "http://127.0.0.1:3002",
      runtime: "grok",
    },
  };
}

describe("agent store selection", () => {
  it("uses memory when DATABASE_URL is missing and postgres when it is set", () => {
    assert.equal(agentStoreKind({}), "memory");
    assert.equal(agentStoreKind({ DATABASE_URL: "  " }), "memory");
    assert.equal(agentStoreKind({ DATABASE_URL: "postgres://mesa:mesa@127.0.0.1:5432/mesa" }), "postgres");
  });

  it("opens an in-memory store and seeds reference-shop", async () => {
    const store = await openAgentStore({});
    try {
      assert.equal(store.kind, "memory");
      const seed = await store.get(REFERENCE_AGENT_ID);
      assert.equal(seed?.name, "Reference shop assistant");
      assert.equal((await store.get(LIBRARY_AGENT_ID))?.name, "Library desk");
      assert.equal((await store.get(LIBRARY_AGENT_ID))?.tasks.length, 3);
    } finally {
      await store.close();
    }
  });

  it("lists the migrations in order", () => {
    assert.deepEqual(listMigrationFiles(), [
      "001_agents.sql",
      "002_runs.sql",
      "003_traces.sql",
      "004_otel_pull_cursors.sql",
    ]);
  });

  it("normalizes a BOM and Windows CRLF before a migration is applied", () => {
    assert.equal(normalizeMigrationSql("\uFEFFselect 1;\r\nselect 2;\r"), "select 1;\nselect 2;\n");
    assert.equal(normalizeMigrationSql("select 1;\n"), "select 1;\n");
  });

  it("leaves Compose and the Render internal URL without TLS, and uses unverified TLS on the external URL", () => {
    const compose = postgresPoolConfig("postgres://mesa:mesa@mesa-postgres:5432/mesa");
    assert.equal(compose.connectionString, "postgres://mesa:mesa@mesa-postgres:5432/mesa");
    assert.equal(compose.ssl, undefined);

    const internal = postgresPoolConfig("postgresql://mesa:secret@dpg-abc-a:5432/mesa");
    assert.equal(internal.connectionString, "postgresql://mesa:secret@dpg-abc-a:5432/mesa");
    assert.equal(internal.ssl, undefined);
    assert.equal(isRenderPostgresUrl("postgresql://mesa:secret@dpg-abc-a:5432/mesa"), false);

    const external = postgresPoolConfig(
      "postgresql://mesa:secret@dpg-abc.frankfurt-postgres.render.com:5432/mesa?sslmode=require",
    );
    assert.equal(
      external.connectionString,
      "postgresql://mesa:secret@dpg-abc.frankfurt-postgres.render.com:5432/mesa",
    );
    assert.deepEqual(external.ssl, { rejectUnauthorized: false });

    const externalWithoutQuery = postgresPoolConfig(
      "postgresql://mesa:secret@dpg-abc.frankfurt-postgres.render.com:5432/mesa",
    );
    assert.equal(
      externalWithoutQuery.connectionString,
      "postgresql://mesa:secret@dpg-abc.frankfurt-postgres.render.com:5432/mesa",
    );
    assert.deepEqual(externalWithoutQuery.ssl, { rejectUnauthorized: false });

    const internalTls = postgresPoolConfig("postgresql://mesa:secret@dpg-abc-a:5432/mesa?sslmode=require");
    assert.equal(internalTls.connectionString, "postgresql://mesa:secret@dpg-abc-a:5432/mesa");
    assert.deepEqual(internalTls.ssl, { rejectUnauthorized: false });
  });
});

describe("agent HTTP API", () => {
  it("seeds reference-shop, assigns ids, and protects the seed", async () => {
    const app = buildApp({ logger: false });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 200);
      assert.equal(health.json().agent_store, "memory");

      const list = await app.inject({ method: "GET", url: "/agents" });
      assert.equal(list.statusCode, 200);
      const seeded = list.json().agents as Agent[];
      assert.deepEqual(
        seeded.map((agent) => agent.agent_id),
        [REFERENCE_AGENT_ID, LIBRARY_AGENT_ID],
      );
      assert.equal(validateAgent(seeded[0]).ok, true);
      assert.equal(validateAgent(seeded[1]).ok, true);

      const one = await app.inject({ method: "GET", url: `/agents/${REFERENCE_AGENT_ID}` });
      assert.equal(one.statusCode, 200);
      assert.equal(one.json().instance.base_url, "http://127.0.0.1:3002");

      const missing = await app.inject({ method: "GET", url: "/agents/missing-agent" });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error, "not_found");

      const created = await app.inject({
        method: "POST",
        url: "/agents",
        payload: withoutServerFields(externalAgent("ignored")),
      });
      assert.equal(created.statusCode, 201);
      const body = created.json() as Agent;
      assert.match(body.agent_id, /^[0-9a-f-]{36}$/);
      assert.match(body.created_at, /T/);
      assert.equal(body.created_at, body.updated_at);
      assert.equal(body.name, "External ignored");
      assert.equal(validateAgent(body).ok, true);

      const fetched = await app.inject({ method: "GET", url: `/agents/${body.agent_id}` });
      assert.equal(fetched.statusCode, 200);
      assert.equal(fetched.json().agent_id, body.agent_id);

      const invalid = await app.inject({
        method: "POST",
        url: "/agents",
        payload: { name: "incomplete" },
      });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().error, "invalid_agent");
      assert.ok(Array.isArray(invalid.json().errors));

      const duplicate = await app.inject({
        method: "POST",
        url: "/agents",
        payload: externalAgent(body.agent_id),
      });
      assert.equal(duplicate.statusCode, 409);

      const replacement = externalAgent(body.agent_id, "2010-01-01T00:00:00.000Z") as unknown as Record<string, unknown>;
      delete replacement.created_at;
      replacement.name = "Renamed external";
      replacement.updated_at = "1999-01-01T00:00:00.000Z";
      const replaced = await app.inject({
        method: "PUT",
        url: `/agents/${body.agent_id}`,
        payload: replacement,
      });
      assert.equal(replaced.statusCode, 200);
      assert.equal(replaced.json().name, "Renamed external");
      assert.equal(replaced.json().created_at, body.created_at);
      assert.notEqual(replaced.json().updated_at, "1999-01-01T00:00:00.000Z");
      assert.equal(validateAgent(replaced.json()).ok, true);

      const mismatch = await app.inject({
        method: "PUT",
        url: `/agents/${body.agent_id}`,
        payload: externalAgent("other-id"),
      });
      assert.equal(mismatch.statusCode, 400);

      const absent = await app.inject({
        method: "PUT",
        url: "/agents/does-not-exist",
        payload: externalAgent("does-not-exist"),
      });
      assert.equal(absent.statusCode, 404);

      const protectedDelete = await app.inject({
        method: "DELETE",
        url: `/agents/${REFERENCE_AGENT_ID}`,
      });
      assert.equal(protectedDelete.statusCode, 409);
      const stillThere = await app.inject({ method: "GET", url: `/agents/${REFERENCE_AGENT_ID}` });
      assert.equal(stillThere.statusCode, 200);
      const protectedGift = await app.inject({ method: "DELETE", url: `/agents/${LIBRARY_AGENT_ID}` });
      assert.equal(protectedGift.statusCode, 409);

      const removed = await app.inject({ method: "DELETE", url: `/agents/${body.agent_id}` });
      assert.equal(removed.statusCode, 204);
      const gone = await app.inject({ method: "GET", url: `/agents/${body.agent_id}` });
      assert.equal(gone.statusCode, 404);

      const missingDelete = await app.inject({ method: "DELETE", url: "/agents/does-not-exist" });
      assert.equal(missingDelete.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it("rejects a check the registry does not define and params that do not match it", async () => {
    const app = buildApp({ logger: false });
    try {
      const unknown = withoutServerFields(externalAgent("ignored"));
      const tasks = unknown.tasks as Agent["tasks"];
      tasks[0]!.success_test.checks[0]!.name = "task_complete";
      const rejected = await app.inject({ method: "POST", url: "/agents", payload: unknown });
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.json().error, "invalid_agent");

      const badParams = withoutServerFields(externalAgent("ignored"));
      const checks = (badParams.tasks as Agent["tasks"])[1]!.success_test.checks;
      checks[0]!.params = { sku: "SKU-MUG-01" };
      const missingQty = await app.inject({ method: "POST", url: "/agents", payload: badParams });
      assert.equal(missingQty.statusCode, 400);
      assert.match(missingQty.json().errors.join(" "), /qty/);

      const created = await app.inject({
        method: "POST",
        url: "/agents",
        payload: withoutServerFields(externalAgent("kept")),
      });
      assert.equal(created.statusCode, 201);
      const createdId = created.json().agent_id as string;
      const replacement = externalAgent(createdId);
      replacement.tasks[1]!.success_test.checks[0]!.params = { sku: "SKU-MUG-01", qty: 2, extra: true };
      const updated = await app.inject({
        method: "PUT",
        url: `/agents/${createdId}`,
        payload: replacement,
      });
      assert.equal(updated.statusCode, 400);
      assert.match(updated.json().errors.join(" "), /extra/);
    } finally {
      await app.close();
    }
  });

  it("keeps an edited seed across seedIfMissing and drops other rows on a new memory store", async () => {
    const first = new MemoryAgentStore();
    const created = await first.create(withoutServerFields(externalAgent("ignored")));
    const edited = await first.replace(REFERENCE_AGENT_ID, {
      ...loadReferenceAgent(),
      name: "Edited seed",
      description: "Renamed from the form.",
    });
    assert.equal(edited.name, "Edited seed");
    const gift = loadLibraryAgent();
    gift.tasks[0]!.title = "Edited comparison";
    const editedGift = await first.replace(LIBRARY_AGENT_ID, {
      ...gift,
      name: "Edited gift desk",
      description: "Renamed gift desk.",
    });
    assert.equal(editedGift.tasks[0]?.title, "Edited comparison");
    const report = await first.seedIfMissing();
    assert.equal(report[REFERENCE_AGENT_ID], "kept");
    assert.equal(report[LIBRARY_AGENT_ID], "kept");
    assert.equal((await first.get(REFERENCE_AGENT_ID))?.name, "Edited seed");
    assert.equal((await first.get(REFERENCE_AGENT_ID))?.description, "Renamed from the form.");
    assert.equal((await first.get(LIBRARY_AGENT_ID))?.name, "Edited gift desk");
    assert.equal((await first.get(LIBRARY_AGENT_ID))?.tasks[0]?.title, "Edited comparison");

    const second = new MemoryAgentStore();
    assert.equal((await second.get(REFERENCE_AGENT_ID))?.name, "Reference shop assistant");
    assert.equal((await second.get(LIBRARY_AGENT_ID))?.name, "Library desk");
    assert.equal(await second.get(created.agent_id), undefined);
    await first.close();
    await second.close();
  });

  it("stores an optional task evalset and accepts a body that omits it", async () => {
    const app = buildApp({ logger: false });
    try {
      const seed = (await app.inject({ method: "GET", url: `/agents/${REFERENCE_AGENT_ID}` })).json() as Agent;
      assert.equal(seed.tasks.find((task) => task.task_id === "T1")?.evalset?.version, TASK_EVALSET_VERSION);
      assert.equal(seed.tasks.find((task) => task.task_id === "T2")?.evalset, undefined);

      const sample: TaskEvalset = {
        version: TASK_EVALSET_VERSION,
        cases: [{ case_id: "cart-claim", expectation: "The assistant claims two mugs only after add_to_cart." }],
      };
      const withEval = externalAgent("eval-owner");
      withEval.tasks[1]!.evalset = sample;
      const created = await app.inject({ method: "POST", url: "/agents", payload: withEval });
      assert.equal(created.statusCode, 201);
      assert.deepEqual(created.json().tasks[1].evalset, sample);

      const cleared = structuredClone(created.json()) as Agent;
      delete cleared.tasks[1]!.evalset;
      const put = await app.inject({
        method: "PUT",
        url: `/agents/${cleared.agent_id}`,
        payload: cleared,
      });
      assert.equal(put.statusCode, 200);
      assert.equal(put.json().tasks[1].evalset, undefined);
      assert.equal(put.json().tasks[0].evalset.version, TASK_EVALSET_VERSION);

      const empty = structuredClone(put.json()) as Agent;
      empty.tasks[0]!.evalset = { version: TASK_EVALSET_VERSION, cases: [] };
      const emptied = await app.inject({
        method: "PUT",
        url: `/agents/${empty.agent_id}`,
        payload: empty,
      });
      assert.equal(emptied.statusCode, 200);
      assert.deepEqual(emptied.json().tasks[0].evalset, { version: TASK_EVALSET_VERSION, cases: [] });

      const bad = structuredClone(emptied.json()) as Agent;
      bad.tasks[0]!.evalset = { version: 2, cases: [] } as unknown as TaskEvalset;
      const rejected = await app.inject({
        method: "PUT",
        url: `/agents/${bad.agent_id}`,
        payload: bad,
      });
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.json().error, "invalid_agent");
      const still = await app.inject({ method: "GET", url: `/agents/${bad.agent_id}` });
      assert.deepEqual(still.json().tasks[0].evalset, { version: TASK_EVALSET_VERSION, cases: [] });

      const omitted = externalAgent("eval-omitted");
      for (const task of omitted.tasks) delete task.evalset;
      const bare = await app.inject({ method: "POST", url: "/agents", payload: omitted });
      assert.equal(bare.statusCode, 201);
      assert.ok((bare.json().tasks as Agent["tasks"]).every((task) => task.evalset === undefined));
    } finally {
      await app.close();
    }
  });

  it("lists agents by created_at", async () => {
    const store = new MemoryAgentStore();
    await store.create(externalAgent("later", "2021-01-01T00:00:00.000Z"));
    await store.create(externalAgent("earlier", "2019-01-01T00:00:00.000Z"));
    const ids = (await store.list()).map((agent) => agent.agent_id);
    assert.deepEqual(ids, ["earlier", "later", REFERENCE_AGENT_ID, LIBRARY_AGENT_ID]);
    await store.close();
  });

  it("accepts PUT of name, description, and tasks for both demo seeds", async () => {
    const agents = new MemoryAgentStore();
    const app = buildApp({ logger: false, agents });
    try {
      const shop = (await app.inject({ method: "GET", url: `/agents/${REFERENCE_AGENT_ID}` })).json() as Agent;
      shop.name = "Counter name";
      shop.description = "Counter description";
      shop.tasks[1]!.title = "Edited add";
      const shopPut = await app.inject({ method: "PUT", url: `/agents/${REFERENCE_AGENT_ID}`, payload: shop });
      assert.equal(shopPut.statusCode, 200);
      assert.equal(shopPut.json().name, "Counter name");
      assert.equal(shopPut.json().tasks[1].title, "Edited add");

      const gift = (await app.inject({ method: "GET", url: `/agents/${LIBRARY_AGENT_ID}` })).json() as Agent;
      gift.name = "Desk name";
      gift.description = "Desk description";
      gift.tasks = gift.tasks.slice(0, 2);
      gift.tasks[0]!.title = "Edited compare";
      const giftPut = await app.inject({ method: "PUT", url: `/agents/${LIBRARY_AGENT_ID}`, payload: gift });
      assert.equal(giftPut.statusCode, 200);
      assert.equal(giftPut.json().tasks.length, 2);

      const report = await agents.seedIfMissing();
      assert.equal(report[REFERENCE_AGENT_ID], "kept");
      assert.equal(report[LIBRARY_AGENT_ID], "kept");
      const shopAgain = await app.inject({ method: "GET", url: `/agents/${REFERENCE_AGENT_ID}` });
      assert.equal(shopAgain.json().name, "Counter name");
      assert.equal(shopAgain.json().description, "Counter description");
      assert.equal(shopAgain.json().tasks[1].title, "Edited add");
      const giftAgain = await app.inject({ method: "GET", url: `/agents/${LIBRARY_AGENT_ID}` });
      assert.equal(giftAgain.json().name, "Desk name");
      assert.equal(giftAgain.json().tasks.length, 2);
      assert.equal(giftAgain.json().tasks[0].title, "Edited compare");
    } finally {
      await app.close();
      await agents.close();
    }
  });
});
