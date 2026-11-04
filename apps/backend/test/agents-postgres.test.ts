import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Agent } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";
import pg from "pg";
import { PostgresAgentStore, postgresPoolConfig } from "../src/agents/postgres.js";
import { REFERENCE_AGENT_ID, StoredAgentSchemaError } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import { loadReferenceAgent } from "../src/reference-agent.js";

/**
 * Postgres checks run only when TEST_DATABASE_URL points at a disposable database.
 * They are skipped in CI. The suite writes schema `mesa_agent_test` and deletes
 * rows there. It does not read or write `public.agents`.
 */
const databaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const TEST_SCHEMA = "mesa_agent_test";

function externalAgent(agentId: string): Agent {
  const agent = loadReferenceAgent();
  return {
    ...agent,
    agent_id: agentId,
    name: `External ${agentId}`,
    description: `Postgres test agent ${agentId}.`,
    instance: {
      kind: "external",
      base_url: "http://127.0.0.1:3002",
      runtime: "grok",
    },
  };
}

function withoutServerFields(agent: Agent): Record<string, unknown> {
  const copy = structuredClone(agent) as unknown as Record<string, unknown>;
  delete copy.agent_id;
  delete copy.created_at;
  delete copy.updated_at;
  return copy;
}

describe("Postgres agent store", { skip: databaseUrl === "" ? "TEST_DATABASE_URL is not set" : false }, () => {
  let store: PostgresAgentStore | undefined;

  before(async () => {
    if (databaseUrl === "") return;
    if (/\.render\.com\b/i.test(databaseUrl)) {
      throw new Error("Refusing to run agent store tests against a Render host. Point TEST_DATABASE_URL at a local database.");
    }
    const admin = new pg.Pool(postgresPoolConfig(databaseUrl));
    try {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    } finally {
      await admin.end();
    }
    store = new PostgresAgentStore(databaseUrl, { searchPath: TEST_SCHEMA });
    await store.migrate();
    await store.migrate();
    await store.deleteAllRowsForTests();
    await store.seedIfMissing();
  });

  after(async () => {
    if (!store) return;
    await store.deleteAllRowsForTests();
    await store.close();
  });

  it("survives a new pool and keeps an edited seed", async () => {
    const agents = store;
    assert.ok(agents);
    const created = await agents.create(withoutServerFields(externalAgent("pg-restart")));
    assert.notEqual(created.agent_id, "pg-restart");
    assert.equal(created.name, "External pg-restart");

    const duplicate = await agents.create(created).catch((error: unknown) => error);
    assert.equal(duplicate instanceof Error, true);
    assert.match((duplicate as Error).message, /already exists/);

    await agents.replace(REFERENCE_AGENT_ID, {
      ...loadReferenceAgent(),
      name: "Edited in postgres",
    });
    await agents.seedIfMissing();

    await assert.rejects(agents.delete(REFERENCE_AGENT_ID), /cannot be deleted/);
    await agents.delete(created.agent_id);
    assert.equal(await agents.get(created.agent_id), undefined);

    const again = await agents.create(externalAgent("pg-durable"));
    const restarted = new PostgresAgentStore(databaseUrl, { searchPath: TEST_SCHEMA });
    try {
      await restarted.migrate();
      const durable = await restarted.get(again.agent_id);
      assert.equal(durable?.name, "External pg-durable");
      assert.equal((await restarted.get(REFERENCE_AGENT_ID))?.name, "Edited in postgres");
      const ids = (await restarted.list()).map((agent) => agent.agent_id);
      assert.equal(ids.includes("pg-durable"), true);
    } finally {
      await restarted.close();
    }
  });

  it("serves the same CRUD routes against Postgres", async () => {
    const agents = store;
    assert.ok(agents);
    const app = buildApp({ logger: false, agents });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.json().agent_store, "postgres");

      const created = await app.inject({
        method: "POST",
        url: "/agents",
        payload: externalAgent("pg-http"),
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().agent_id, "pg-http");

      const fetched = await app.inject({ method: "GET", url: "/agents/pg-http" });
      assert.equal(fetched.statusCode, 200);
      assert.equal(fetched.json().description, "Postgres test agent pg-http.");

      const removed = await app.inject({ method: "DELETE", url: "/agents/pg-http" });
      assert.equal(removed.statusCode, 204);

      const blocked = await app.inject({ method: "DELETE", url: `/agents/${REFERENCE_AGENT_ID}` });
      assert.equal(blocked.statusCode, 409);
    } finally {
      await app.close();
    }
  });
});

/**
 * The document `reference-shop` had before `tasks[].setup` was required.
 * Timestamps match the fixture, which is the row Render already stored.
 */
function legacyAgent(agentId: string, createdAt = "2019-06-01T00:00:00.000Z"): Record<string, unknown> {
  const fixture = loadReferenceAgent();
  const agent = structuredClone(fixture) as unknown as Record<string, unknown>;
  if (agentId !== REFERENCE_AGENT_ID) {
    agent.agent_id = agentId;
    agent.name = `Legacy ${agentId}`;
    agent.description = `Legacy stored agent ${agentId}.`;
    agent.created_at = createdAt;
    agent.updated_at = createdAt;
  }
  for (const task of agent.tasks as Array<Record<string, unknown>>) delete task.setup;
  return agent;
}

describe(
  "Postgres stale reference-shop",
  { skip: databaseUrl === "" ? "TEST_DATABASE_URL is not set" : false },
  () => {
    const STALE_SCHEMA = "mesa_agent_stale_test";
    let store: PostgresAgentStore | undefined;

    before(async () => {
      if (databaseUrl === "") return;
      if (/\.render\.com\b/i.test(databaseUrl)) {
        throw new Error("Refusing to run agent store tests against a Render host. Point TEST_DATABASE_URL at a local database.");
      }
      const admin = new pg.Pool(postgresPoolConfig(databaseUrl));
      try {
        await admin.query(`CREATE SCHEMA IF NOT EXISTS ${STALE_SCHEMA}`);
      } finally {
        await admin.end();
      }
      store = new PostgresAgentStore(databaseUrl, { searchPath: STALE_SCHEMA });
      await store.migrate();
      await store.deleteAllRowsForTests();
    });

    after(async () => {
      if (!store) return;
      await store.deleteAllRowsForTests();
      await store.close();
    });

    it("rewrites an old-format seed at startup and keeps the list routes up", async () => {
      const agents = store;
      assert.ok(agents);
      await agents.deleteAllRowsForTests();
      const stale = legacyAgent(REFERENCE_AGENT_ID);
      const other = legacyAgent("legacy-shop");
      assert.equal(validateAgent(stale).ok, false);
      await agents.putRawForTests(stale);
      await agents.putRawForTests(other);
      await assert.rejects(agents.get(REFERENCE_AGENT_ID), (error: unknown) => {
        assert.ok(error instanceof StoredAgentSchemaError);
        assert.match(error.message, /Stored agent failed schema/);
        return true;
      });
      assert.equal(await agents.seedIfMissing(), "refreshed");

      const app = buildApp({ logger: false, agents });
      try {
        const fixture = loadReferenceAgent();
        const one = await app.inject({ method: "GET", url: `/agents/${REFERENCE_AGENT_ID}` });
        assert.equal(one.statusCode, 200);
        const body = one.json() as Agent;
        assert.deepEqual(
          body.tasks.map((task) => ({ task_id: task.task_id, setup: task.setup })),
          fixture.tasks.map((task) => ({ task_id: task.task_id, setup: task.setup })),
        );
        for (const taskId of ["T1", "T2", "T3", "T4", "T5"]) {
          assert.ok(body.tasks.find((task) => task.task_id === taskId)?.setup, taskId);
        }

        const list = await app.inject({ method: "GET", url: "/agents" });
        assert.equal(list.statusCode, 200);
        assert.deepEqual(
          (list.json().agents as Agent[]).map((agent) => agent.agent_id),
          [REFERENCE_AGENT_ID],
        );

        const runs = await app.inject({ method: "GET", url: "/runs" });
        assert.equal(runs.statusCode, 200);
        assert.equal(runs.json().counts.agents, 1);
        assert.deepEqual(runs.json().runs, []);
      } finally {
        await app.close();
      }

      const repairBody = {
        ...loadReferenceAgent(),
        agent_id: "legacy-shop",
        name: "Repaired",
        description: "Repaired stale postgres agent.",
      } as Record<string, unknown>;
      delete repairBody.created_at;
      delete repairBody.updated_at;
      const repaired = await agents.replace("legacy-shop", repairBody);
      assert.equal(repaired.created_at, other.created_at);
      assert.ok(repaired.tasks[0]?.setup);

      await agents.putRawForTests(legacyAgent("legacy-import"));
      const incoming = externalAgent("legacy-import");
      incoming.created_at = "2024-05-05T00:00:00.000Z";
      incoming.updated_at = "2024-05-05T00:00:00.000Z";
      incoming.name = "Imported over stale";
      assert.equal(await agents.upsertImported(incoming), "updated");
      const imported = await agents.get("legacy-import");
      assert.equal(imported?.created_at, "2019-06-01T00:00:00.000Z");
      assert.equal(imported?.name, "Imported over stale");
      assert.ok(imported?.tasks[0]?.setup);

      await agents.replace(REFERENCE_AGENT_ID, {
        ...loadReferenceAgent(),
        name: "Edited after heal",
      });
      assert.equal(await agents.seedIfMissing(), "kept");
      assert.equal((await agents.get(REFERENCE_AGENT_ID))?.name, "Edited after heal");
    });

    it("rewrites a valid seed whose updated_at is older than the fixture", async () => {
      const agents = store;
      assert.ok(agents);
      const older = loadReferenceAgent();
      older.name = "Older valid seed";
      older.updated_at = "2020-01-01T00:00:00.000Z";
      await agents.putRawForTests(older);
      assert.equal(await agents.seedIfMissing(), "refreshed");
      assert.equal((await agents.get(REFERENCE_AGENT_ID))?.name, "Reference shop assistant");
      assert.equal((await agents.get(REFERENCE_AGENT_ID))?.updated_at, loadReferenceAgent().updated_at);
    });
  },
);
