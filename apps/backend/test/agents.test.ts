import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";
import { openAgentStore, agentStoreKind } from "../src/agents/open.js";
import { listMigrationFiles, postgresPoolConfig } from "../src/agents/postgres.js";
import { MemoryAgentStore, REFERENCE_AGENT_ID } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import { loadReferenceAgent } from "../src/reference-agent.js";

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
    } finally {
      await store.close();
    }
  });

  it("lists the agent migrations in order", () => {
    assert.deepEqual(listMigrationFiles(), ["001_agents.sql"]);
  });

  it("turns Render sslmode=require into unverified TLS and leaves local URLs alone", () => {
    const local = postgresPoolConfig("postgres://mesa:mesa@mesa-postgres:5432/mesa");
    assert.equal(local.connectionString, "postgres://mesa:mesa@mesa-postgres:5432/mesa");
    assert.equal(local.ssl, undefined);

    const render = postgresPoolConfig(
      "postgresql://mesa:secret@dpg-abc.frankfurt-postgres.render.com:5432/mesa?sslmode=require",
    );
    assert.equal(
      render.connectionString,
      "postgresql://mesa:secret@dpg-abc.frankfurt-postgres.render.com:5432/mesa",
    );
    assert.deepEqual(render.ssl, { rejectUnauthorized: false });
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
      assert.equal(seeded.length, 1);
      assert.equal(seeded[0]?.agent_id, REFERENCE_AGENT_ID);
      assert.equal(validateAgent(seeded[0]).ok, true);

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

  it("keeps an edited seed across seedIfMissing and drops other rows on a new memory store", async () => {
    const first = new MemoryAgentStore();
    const created = await first.create(withoutServerFields(externalAgent("ignored")));
    const edited = await first.replace(REFERENCE_AGENT_ID, {
      ...loadReferenceAgent(),
      name: "Edited seed",
    });
    assert.equal(edited.name, "Edited seed");
    await first.seedIfMissing();
    assert.equal((await first.get(REFERENCE_AGENT_ID))?.name, "Edited seed");

    const second = new MemoryAgentStore();
    assert.equal((await second.get(REFERENCE_AGENT_ID))?.name, "Reference shop assistant");
    assert.equal(await second.get(created.agent_id), undefined);
    await first.close();
    await second.close();
  });

  it("lists agents by created_at", async () => {
    const store = new MemoryAgentStore();
    await store.create(externalAgent("later", "2021-01-01T00:00:00.000Z"));
    await store.create(externalAgent("earlier", "2019-01-01T00:00:00.000Z"));
    const ids = (await store.list()).map((agent) => agent.agent_id);
    assert.deepEqual(ids, ["earlier", "later", REFERENCE_AGENT_ID]);
    await store.close();
  });
});
