import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Agent } from "@mesa/shared";
import pg from "pg";
import { PostgresAgentStore, postgresPoolConfig } from "../src/agents/postgres.js";
import {
  DEMO_REFERENCE_SHOP_GITHUB_REPO_URL,
  LIBRARY_AGENT_ID,
  MemoryAgentStore,
  REFERENCE_AGENT_ID,
  backfillGithubRepoUrl,
} from "../src/agents/store.js";
import { loadLibraryAgent, loadReferenceAgent } from "../src/reference-agent.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";

function withoutGithubRepo(agent: Agent): Record<string, unknown> {
  const copy = structuredClone(agent) as unknown as Record<string, unknown>;
  delete copy.github_repo_url;
  return copy;
}

describe("github_repo_url seed backfill (memory)", () => {
  it("inserts github_repo_url on a fresh store", async () => {
    const agents = new MemoryAgentStore();
    try {
      const shop = await agents.get(REFERENCE_AGENT_ID);
      assert.equal(shop?.github_repo_url, DEMO_REFERENCE_SHOP_GITHUB_REPO_URL);
      assert.equal(loadReferenceAgent().github_repo_url, DEMO_REFERENCE_SHOP_GITHUB_REPO_URL);
      const library = await agents.get(LIBRARY_AGENT_ID);
      assert.equal(library?.github_repo_url, undefined);
      assert.equal(loadLibraryAgent().github_repo_url, undefined);
    } finally {
      await agents.close();
    }
  });

  it("sets github_repo_url when the stored seed lacks it and leaves other fields", async () => {
    const agents = new MemoryAgentStore();
    try {
      const planted = withoutGithubRepo(loadReferenceAgent());
      planted.name = "Custom shop name";
      planted.updated_at = "2099-01-01T00:00:00.000Z";
      agents.putRawForTests(planted);
      const report = await agents.seedIfMissing();
      assert.equal(report[REFERENCE_AGENT_ID], "backfilled");
      assert.equal(report[LIBRARY_AGENT_ID], "kept");
      const shop = await agents.get(REFERENCE_AGENT_ID);
      assert.equal(shop?.github_repo_url, DEMO_REFERENCE_SHOP_GITHUB_REPO_URL);
      assert.equal(shop?.name, "Custom shop name");
      assert.equal(shop?.updated_at, "2099-01-01T00:00:00.000Z");
    } finally {
      await agents.close();
    }
  });

  it("backfills a same-age seed that was stored without github_repo_url", async () => {
    const agents = new MemoryAgentStore();
    try {
      agents.putRawForTests(withoutGithubRepo(loadReferenceAgent()));
      const report = await agents.seedIfMissing();
      assert.equal(report[REFERENCE_AGENT_ID], "backfilled");
      assert.equal((await agents.get(REFERENCE_AGENT_ID))?.github_repo_url, DEMO_REFERENCE_SHOP_GITHUB_REPO_URL);
    } finally {
      await agents.close();
    }
  });

  it("does not overwrite an operator-set github_repo_url", async () => {
    const planted = loadReferenceAgent();
    planted.github_repo_url = "https://github.com/example/operator-agent";
    planted.name = "Operator shop";
    planted.updated_at = "2099-06-01T00:00:00.000Z";
    const agents = new MemoryAgentStore([planted]);
    try {
      const shop = await agents.get(REFERENCE_AGENT_ID);
      assert.equal(shop?.github_repo_url, "https://github.com/example/operator-agent");
      assert.equal(shop?.name, "Operator shop");
      const report = await agents.seedIfMissing();
      assert.equal(report[REFERENCE_AGENT_ID], "kept");
      assert.equal((await agents.get(REFERENCE_AGENT_ID))?.github_repo_url, "https://github.com/example/operator-agent");
    } finally {
      await agents.close();
    }
  });

  it("backfillGithubRepoUrl is a no-op when the fixture has no URL", () => {
    const stored = loadLibraryAgent();
    const fixture = loadLibraryAgent();
    assert.equal(backfillGithubRepoUrl(stored, fixture), undefined);
  });
});

describe(
  "github_repo_url seed backfill (postgres)",
  { skip: databaseUrl === "" ? "TEST_DATABASE_URL is not set" : false },
  () => {
    const SCHEMA = "mesa_agent_github_seed_test";
    let store: PostgresAgentStore | undefined;

    before(async () => {
      if (databaseUrl === "") return;
      if (/\.render\.com\b/i.test(databaseUrl)) {
        throw new Error(
          "Refusing to run agent store tests against a Render host. Point TEST_DATABASE_URL at a local database.",
        );
      }
      const admin = new pg.Pool(postgresPoolConfig(databaseUrl));
      try {
        await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      } finally {
        await admin.end();
      }
      store = new PostgresAgentStore(databaseUrl, { searchPath: SCHEMA });
      await store.migrate();
      await store.deleteAllRowsForTests();
    });

    after(async () => {
      if (!store) return;
      await store.deleteAllRowsForTests();
      await store.close();
    });

    it("inserts github_repo_url on a fresh database and backfills a missing field", async () => {
      const agents = store;
      assert.ok(agents);
      await agents.deleteAllRowsForTests();
      const inserted = await agents.seedIfMissing();
      assert.equal(inserted[REFERENCE_AGENT_ID], "inserted");
      assert.equal((await agents.get(REFERENCE_AGENT_ID))?.github_repo_url, DEMO_REFERENCE_SHOP_GITHUB_REPO_URL);

      const missing = withoutGithubRepo((await agents.get(REFERENCE_AGENT_ID))!);
      missing.name = "Postgres custom shop";
      missing.updated_at = "2099-01-01T00:00:00.000Z";
      await agents.putRawForTests(missing);
      const filled = await agents.seedIfMissing();
      assert.equal(filled[REFERENCE_AGENT_ID], "backfilled");
      const shop = await agents.get(REFERENCE_AGENT_ID);
      assert.equal(shop?.github_repo_url, DEMO_REFERENCE_SHOP_GITHUB_REPO_URL);
      assert.equal(shop?.name, "Postgres custom shop");

      const operator = (await agents.get(REFERENCE_AGENT_ID))!;
      operator.github_repo_url = "https://github.com/example/operator-agent";
      await agents.putRawForTests(operator);
      const kept = await agents.seedIfMissing();
      assert.equal(kept[REFERENCE_AGENT_ID], "kept");
      assert.equal((await agents.get(REFERENCE_AGENT_ID))?.github_repo_url, "https://github.com/example/operator-agent");
    });
  },
);
