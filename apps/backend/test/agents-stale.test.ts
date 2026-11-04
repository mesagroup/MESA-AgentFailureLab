import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";
import { LIBRARY_AGENT_ID, MemoryAgentStore, REFERENCE_AGENT_ID, StoredAgentSchemaError } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { exportStores, importPersistence, resetKeepingSeed } from "../src/persistence/transfer.js";
import { loadReferenceAgent } from "../src/reference-agent.js";

/**
 * The document `reference-shop` had before `tasks[].setup` was required.
 * Timestamps match the fixture, which is how the Postgres row was written.
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

function externalAgent(agentId: string, createdAt = "2024-05-05T00:00:00.000Z"): Agent {
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

function withoutTimestamps(agent: Agent): Record<string, unknown> {
  const copy = structuredClone(agent) as unknown as Record<string, unknown>;
  delete copy.created_at;
  delete copy.updated_at;
  return copy;
}

async function withWarnings<T>(body: (warnings: string[]) => Promise<T>): Promise<T> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown, ...rest: unknown[]) => {
    warnings.push([message, ...rest].map((part) => String(part)).join(" "));
  };
  try {
    return await body(warnings);
  } finally {
    console.warn = original;
  }
}

describe("stale reference-shop", () => {
  it("rewrites an old-format seed at startup and keeps the list routes up", async () => {
    await withWarnings(async (warnings) => {
      const stale = legacyAgent(REFERENCE_AGENT_ID);
      const other = legacyAgent("legacy-shop");
      const checked = validateAgent(stale);
      assert.equal(checked.ok, false);
      if (!checked.ok) assert.match(checked.errors.join("; "), /required property 'setup'/);

      const agents = new MemoryAgentStore([stale, other]);
      const seeded = await agents.seedIfMissing();
      assert.equal(seeded[REFERENCE_AGENT_ID], "kept");
      assert.equal(seeded[LIBRARY_AGENT_ID], "kept");
      assert.ok(warnings.some((line) => line.includes("Rewrote stored agent reference-shop")));
      assert.ok(warnings.some((line) => line.includes("stored document failed schema")));

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
          const task = body.tasks.find((entry) => entry.task_id === taskId);
          assert.ok(task?.setup, taskId);
          assert.ok(Array.isArray(task.setup.cart));
          assert.ok(Array.isArray(task.setup.orders));
          assert.ok(Array.isArray(task.setup.permissions));
        }

        const list = await app.inject({ method: "GET", url: "/agents" });
        assert.equal(list.statusCode, 200);
        assert.deepEqual(
          (list.json().agents as Agent[]).map((agent) => agent.agent_id),
          [REFERENCE_AGENT_ID, LIBRARY_AGENT_ID],
        );

        const runs = await app.inject({ method: "GET", url: "/runs" });
        assert.equal(runs.statusCode, 200);
        assert.equal(runs.json().counts.agents, 2);
        assert.deepEqual(runs.json().runs, []);

        const broken = await app.inject({ method: "GET", url: "/agents/legacy-shop" });
        assert.equal(broken.statusCode, 500);
        assert.match(broken.json().message, /Stored agent failed schema/);

        const repaired = await app.inject({
          method: "PUT",
          url: "/agents/legacy-shop",
          payload: withoutTimestamps(externalAgent("legacy-shop")),
        });
        assert.equal(repaired.statusCode, 200);
        assert.equal(repaired.json().created_at, other.created_at);
        assert.equal(repaired.json().tasks[0].setup.permissions[0], "read");

        const after = await app.inject({ method: "GET", url: "/agents" });
        assert.equal(after.statusCode, 200);
        assert.deepEqual(
          (after.json().agents as Agent[]).map((agent) => agent.agent_id),
          ["legacy-shop", REFERENCE_AGENT_ID, LIBRARY_AGENT_ID],
        );
      } finally {
        await app.close();
        await agents.close();
      }

      assert.ok(warnings.some((line) => line.includes("Skipping stored agent legacy-shop")));
    });
  });

  it("refreshes a seed planted after boot when seedIfMissing runs", async () => {
    const agents = new MemoryAgentStore();
    agents.putRawForTests(legacyAgent(REFERENCE_AGENT_ID));
    await assert.rejects(agents.get(REFERENCE_AGENT_ID), (error: unknown) => {
      assert.ok(error instanceof StoredAgentSchemaError);
      assert.match(error.message, /Stored agent failed schema/);
      return true;
    });
    const refreshed = await agents.seedIfMissing();
    assert.equal(refreshed[REFERENCE_AGENT_ID], "refreshed");
    assert.equal(refreshed[LIBRARY_AGENT_ID], "kept");
    const seed = await agents.get(REFERENCE_AGENT_ID);
    assert.equal(seed?.tasks.length, 5);
    assert.ok(seed?.tasks.every((task) => task.setup));
    const again = await agents.seedIfMissing();
    assert.equal(again[REFERENCE_AGENT_ID], "kept");
    assert.equal(again[LIBRARY_AGENT_ID], "kept");
    await agents.close();
  });

  it("rewrites a valid seed only when it is older than the fixture", async () => {
    const older = loadReferenceAgent();
    older.name = "Older valid seed";
    older.updated_at = "2020-01-01T00:00:00.000Z";
    const rewritten = new MemoryAgentStore([older]);
    assert.equal((await rewritten.get(REFERENCE_AGENT_ID))?.name, "Reference shop assistant");
    assert.equal((await rewritten.get(REFERENCE_AGENT_ID))?.updated_at, loadReferenceAgent().updated_at);
    assert.equal((await rewritten.get(REFERENCE_AGENT_ID))?.tasks[0]?.evalset?.version, 1);

    const newerWithout = loadReferenceAgent();
    for (const task of newerWithout.tasks) delete task.evalset;
    newerWithout.name = "No evalset";
    newerWithout.updated_at = "2099-01-01T00:00:00.000Z";
    const keptOmit = new MemoryAgentStore([newerWithout]);
    assert.equal((await keptOmit.get(REFERENCE_AGENT_ID))?.name, "No evalset");
    assert.ok((await keptOmit.get(REFERENCE_AGENT_ID))?.tasks.every((task) => task.evalset === undefined));
    await keptOmit.close();

    const sameAge = loadReferenceAgent();
    sameAge.name = "Same age custom";
    const kept = new MemoryAgentStore([sameAge]);
    assert.equal((await kept.get(REFERENCE_AGENT_ID))?.name, "Same age custom");

    const brokenNewer = legacyAgent(REFERENCE_AGENT_ID);
    brokenNewer.name = "Broken custom";
    brokenNewer.updated_at = "2099-01-01T00:00:00.000Z";
    const healed = new MemoryAgentStore([brokenNewer]);
    assert.equal((await healed.get(REFERENCE_AGENT_ID))?.name, "Reference shop assistant");
    assert.ok((await healed.get(REFERENCE_AGENT_ID))?.tasks[0]?.setup);

    await rewritten.close();
    await kept.close();
    await healed.close();
  });

  it("lets import replace an invalid row and keeps its created_at", async () => {
    const agents = new MemoryAgentStore();
    const legacy = legacyAgent("legacy-import");
    agents.putRawForTests(legacy);
    const runs = new MemoryStore();
    const exported = await exportStores(agents, runs);
    assert.equal(
      exported.agents.some((agent) => agent.agent_id === "legacy-import"),
      false,
    );
    const counts = await importPersistence(agents, runs, {
      ...exported,
      agents: [...exported.agents, externalAgent("legacy-import")],
    });
    assert.equal(counts.agents.updated, 3);
    const imported = await agents.get("legacy-import");
    assert.equal(imported?.created_at, legacy.created_at);
    assert.equal(imported?.name, "External legacy-import");
    assert.ok(imported?.tasks[0]?.setup);
    await agents.close();
    await runs.close();
  });

  it("resets when the seed document is invalid and rewrites it from the fixture", async () => {
    const agents = new MemoryAgentStore();
    agents.putRawForTests(legacyAgent(REFERENCE_AGENT_ID));
    agents.putRawForTests(legacyAgent("gone"));
    const runs = new MemoryStore();
    const counts = await resetKeepingSeed(agents, runs);
    assert.equal(counts.seed[REFERENCE_AGENT_ID], "refreshed");
    assert.equal(counts.seed[LIBRARY_AGENT_ID], "kept");
    assert.equal(counts.agents_deleted, 1);
    const seed = await agents.get(REFERENCE_AGENT_ID);
    assert.equal(seed?.name, "Reference shop assistant");
    assert.ok(seed?.tasks.every((task) => task.setup));
    assert.equal(await agents.get("gone"), undefined);
    await agents.close();
    await runs.close();
  });
});
