import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Agent } from "@mesa/shared";
import pg from "pg";
import { PostgresAgentStore, postgresPoolConfig } from "../src/agents/postgres.js";
import { REFERENCE_AGENT_ID } from "../src/agents/store.js";
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
