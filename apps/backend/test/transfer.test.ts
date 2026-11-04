import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent, Run, Trace } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import { isRenderPostgresUrl } from "../src/agents/postgres.js";
import { GIFT_DESK_AGENT_ID, MemoryAgentStore, ProtectedAgentError, REFERENCE_AGENT_ID } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import { applyEnvFile, resolveCliPath, runPersistenceCli } from "../src/persistence/cli.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { ContractError } from "../src/persistence/store.js";
import {
  databaseTargetLabel,
  exportFromHttp,
  exportStores,
  httpExportAdvisory,
  importPersistence,
  parsePersistenceExportText,
  resetKeepingSeed,
  serializePersistenceExport,
  type PersistenceExport,
} from "../src/persistence/transfer.js";
import { loadReferenceAgent } from "../src/reference-agent.js";

function readFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/jury/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function baselineRun(): Run {
  const result = validateRun(readFixture("baseline-run.json"));
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("baseline run");
  return result.value;
}

function baselineTrace(): Trace {
  const result = validateTrace(readFixture("baseline-trace.json"));
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("baseline trace");
  return result.value;
}

function externalAgent(agentId: string, createdAt = "2021-05-01T00:00:00.000Z"): Agent {
  const agent = loadReferenceAgent();
  return {
    ...agent,
    agent_id: agentId,
    name: `External ${agentId}`,
    description: `Transfer test agent ${agentId}.`,
    created_at: createdAt,
    updated_at: createdAt,
    instance: {
      kind: "external",
      base_url: "http://127.0.0.1:3002",
      runtime: "grok",
    },
  };
}

function captureIo(): { stdout: string[]; stderr: string[]; io: { stdout: (line: string) => void; stderr: (line: string) => void } } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}

describe("persistence export file", () => {
  it("rejects a document that fails validateRun and accepts a BOM plus CR LF", async () => {
    const agents = new MemoryAgentStore();
    const runs = new MemoryStore();
    const exported = await exportStores(agents, runs, new Date("2026-11-04T12:00:00.000Z"));
    const bad = {
      ...exported,
      runs: [{ created_at: "2024-01-01T00:00:00.000Z", document: { ...baselineRun(), phase: "sideways" } }],
    };
    assert.throws(() => parsePersistenceExportText(JSON.stringify(bad)), /validateRun/);

    const text = serializePersistenceExport(exported);
    assert.equal(text.includes("\r"), false);
    assert.equal(text.endsWith("\n"), true);
    const crlf = `\uFEFF${text.replace(/\n/g, "\r\n")}`;
    const parsed = parsePersistenceExportText(crlf);
    assert.equal(parsed.format, "mesa-persistence-v1");
    assert.equal(parsed.source, "memory");
    assert.equal(parsed.created_at_source, "order");
    assert.equal(parsed.agents[0]?.agent_id, REFERENCE_AGENT_ID);
    assert.equal(parsed.exported_at, "2026-11-04T12:00:00.000Z");

    const duplicate = structuredClone(exported);
    duplicate.agents.push(structuredClone(duplicate.agents[0]!));
    assert.throws(() => parsePersistenceExportText(JSON.stringify(duplicate)), /Duplicate agent_id/);
    await agents.close();
    await runs.close();
  });

  it("hides the database password in the target label and recognizes a Render host", () => {
    const label = databaseTargetLabel("postgres://mesa:secret@127.0.0.1:5432/mesa");
    assert.equal(label, "127.0.0.1:5432/mesa");
    assert.equal(label.includes("secret"), false);
    assert.equal(isRenderPostgresUrl("postgres://mesa:secret@dpg-abc.frankfurt-postgres.render.com:5432/mesa"), true);
    assert.equal(isRenderPostgresUrl("postgresql://mesa:secret@dpg-abc-a:5432/mesa"), false);
    assert.equal(isRenderPostgresUrl("postgres://mesa:mesa@127.0.0.1:5432/mesa"), false);
    assert.match(httpExportAdvisory("postgres", "postgres"), /cannot read the SQL created_at/);
    assert.match(httpExportAdvisory("memory", "memory"), /no created_at column/);
  });
});

describe("in-memory backup and reset", () => {
  it("round-trips documents, keeps the first created_at, and does not delete rows missing from a later file", async () => {
    const sourceAgents = new MemoryAgentStore();
    const sourceRuns = new MemoryStore();
    const extra = externalAgent("shop-extra");
    await sourceAgents.upsertImported(extra);
    const run = baselineRun();
    const trace = baselineTrace();
    const second: Run = { ...run, run_id: "run-second", task_id: "T1", trace_ids: [] };
    await sourceRuns.upsertImportedRun(second, "2024-02-02T00:00:00.000Z");
    await sourceRuns.upsertImportedRun(run, "2024-01-01T00:00:00.000Z");
    await sourceRuns.upsertImportedTrace(trace, "2024-01-01T00:00:01.000Z");

    const exported = await exportStores(sourceAgents, sourceRuns);
    assert.deepEqual(
      exported.runs.map((row) => row.document.run_id),
      ["run-second", run.run_id],
    );

    const agents = new MemoryAgentStore();
    const runs = new MemoryStore();
    const imported = await importPersistence(agents, runs, exported);
    assert.equal(imported.agents.inserted, 1);
    assert.equal(imported.agents.updated, 2);
    assert.equal(imported.runs.inserted, 2);
    assert.deepEqual(
      (await runs.listRuns()).map((item) => item.run_id),
      [run.run_id, "run-second"],
    );
    assert.equal((await runs.listRunRecords())[0]?.created_at, "2024-01-01T00:00:00.000Z");
    assert.deepEqual(await runs.getTrace(trace.trace_id), trace);
    assert.equal((await agents.get(extra.agent_id))?.created_at, extra.created_at);

    const moved = structuredClone(exported) satisfies PersistenceExport;
    const movedRun = moved.runs.find((row) => row.document.run_id === run.run_id);
    assert.ok(movedRun);
    movedRun.created_at = "1999-01-01T00:00:00.000Z";
    movedRun.document = { ...movedRun.document, duration_ms: 4242 };
    const movedAgent = moved.agents.find((agent) => agent.agent_id === extra.agent_id);
    assert.ok(movedAgent);
    movedAgent.created_at = "1999-05-05T00:00:00.000Z";
    movedAgent.name = "Renamed extra";
    movedAgent.updated_at = "2026-01-01T00:00:00.000Z";
    const again = await importPersistence(agents, runs, moved);
    assert.equal(again.runs.updated, 2);
    assert.equal(again.runs.inserted, 0);
    assert.equal((await runs.listRunRecords()).find((row) => row.document.run_id === run.run_id)?.created_at, "2024-01-01T00:00:00.000Z");
    assert.equal((await runs.getRun(run.run_id))?.duration_ms, 4242);
    assert.equal((await agents.get(extra.agent_id))?.created_at, extra.created_at);
    assert.equal((await agents.get(extra.agent_id))?.name, "Renamed extra");
    assert.equal((await agents.get(extra.agent_id))?.updated_at, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(
      (await runs.listRuns()).map((item) => item.run_id),
      [run.run_id, "run-second"],
    );

    const empty: PersistenceExport = { ...exported, agents: [], runs: [], traces: [] };
    await importPersistence(agents, runs, empty);
    assert.equal((await agents.list()).length, 3);
    assert.equal((await runs.listRuns()).length, 2);
    await sourceAgents.close();
    await sourceRuns.close();
    await agents.close();
    await runs.close();
  });

  it("rejects an invalid import before writing and resets without deleting the seed", async () => {
    const agents = new MemoryAgentStore();
    const runs = new MemoryStore();
    const run = baselineRun();
    await runs.upsertImportedRun(run, "2024-03-03T00:00:00.000Z");
    const exported = await exportStores(agents, runs);
    const bad = structuredClone(exported);
    bad.traces.push({
      created_at: "2024-03-03T00:00:01.000Z",
      document: { ...baselineTrace(), diagnosis: "not-an-object" } as unknown as Trace,
    });
    await assert.rejects(importPersistence(agents, runs, bad), /validateTrace/);
    assert.equal((await runs.listTraces()).length, 0);
    assert.equal((await runs.listRuns()).length, 1);

    await agents.upsertImported(externalAgent("shop-gone"));
    const edited = await agents.replace(REFERENCE_AGENT_ID, {
      ...loadReferenceAgent(),
      name: "Edited seed",
    });
    const counts = await resetKeepingSeed(agents, runs);
    assert.equal(counts.seed[REFERENCE_AGENT_ID], "kept");
    assert.equal(counts.seed[GIFT_DESK_AGENT_ID], "kept");
    assert.equal(counts.agents_deleted, 1);
    assert.equal(counts.runs_deleted, 1);
    assert.deepEqual(
      (await agents.list()).map((agent) => agent.agent_id),
      [REFERENCE_AGENT_ID, GIFT_DESK_AGENT_ID],
    );
    assert.equal((await agents.get(REFERENCE_AGENT_ID))?.name, "Edited seed");
    assert.equal((await agents.get(REFERENCE_AGENT_ID))?.created_at, edited.created_at);
    assert.deepEqual(await runs.listRuns(), []);
    assert.deepEqual(await runs.listTraces(), []);
    await assert.rejects(agents.delete(REFERENCE_AGENT_ID), (error: unknown) => {
      assert.ok(error instanceof ProtectedAgentError);
      return true;
    });
    await assert.rejects(
      runs.upsertImportedRun({ ...run, phase: "sideways" } as unknown as Run, "2024-03-03T00:00:00.000Z"),
      (error: unknown) => {
        assert.ok(error instanceof ContractError);
        return true;
      },
    );
    assert.equal((await runs.listRuns()).length, 0);
    await agents.close();
    await runs.close();
  });
});

describe("HTTP export of a running backend", () => {
  it("reads agents, runs, and traces from the process and preserves store order", async () => {
    const agents = new MemoryAgentStore();
    const runs = new MemoryStore();
    await agents.upsertImported(externalAgent("shop-http"));
    const first = baselineRun();
    const second: Run = { ...first, run_id: "run-http-2", task_id: "T1", trace_ids: ["trace-http-2"] };
    const firstTrace = baselineTrace();
    const secondTrace: Trace = { ...firstTrace, trace_id: "trace-http-2", run_id: second.run_id, task_id: "T1" };
    await runs.saveRun(first);
    await runs.saveTrace(firstTrace);
    await runs.saveRun(second);
    await runs.saveTrace(secondTrace);

    const app = buildApp({ logger: false, agents, store: runs });
    const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const exported = await exportFromHttp(baseUrl, new Date("2026-11-04T12:00:00.000Z"));
      assert.equal(exported.agent_store, "memory");
      assert.equal(exported.run_store, "memory");
      assert.equal(exported.data.source, "http");
      assert.equal(exported.data.created_at_source, "order");
      assert.match(exported.advisory, /order-preserving timestamps/);
      assert.deepEqual(
        exported.data.agents.map((agent) => agent.agent_id),
        ["shop-http", REFERENCE_AGENT_ID, GIFT_DESK_AGENT_ID],
      );
      assert.deepEqual(
        exported.data.runs.map((row) => row.document.run_id),
        [first.run_id, second.run_id],
      );
      assert.deepEqual(
        exported.data.traces.map((row) => row.document.trace_id),
        [firstTrace.trace_id, secondTrace.trace_id],
      );
      assert.equal(Object.hasOwn(exported.data.runs[0]?.document ?? {}, "created_at"), false);
      assert.equal(exported.data.runs[0]?.created_at, "2000-01-01T00:00:00.000Z");
      assert.equal(exported.data.runs[1]?.created_at, "2000-01-01T00:00:00.001Z");

      const restoredAgents = new MemoryAgentStore();
      const restoredRuns = new MemoryStore();
      await importPersistence(restoredAgents, restoredRuns, exported.data);
      assert.deepEqual(
        (await restoredRuns.listRuns()).map((run) => run.run_id),
        [first.run_id, second.run_id],
      );
      assert.deepEqual(await restoredRuns.getTrace(secondTrace.trace_id), secondTrace);
      await restoredAgents.close();
      await restoredRuns.close();
    } finally {
      await app.close();
      await agents.close();
      await runs.close();
    }
  });
});

describe("persistence CLI", () => {
  it("refuses a memory export, a reset without --yes, and a bad file before opening Postgres", async () => {
    const refused = captureIo();
    assert.equal(await runPersistenceCli(["export", "--out", "backup.json"], {}, refused.io), 1);
    assert.match(refused.stderr.join("\n"), /--base-url/);

    const reset = captureIo();
    const dead = { DATABASE_URL: "postgres://mesa:mesa@127.0.0.1:1/mesa" };
    assert.equal(await runPersistenceCli(["reset"], dead, reset.io), 1);
    assert.match(reset.stderr.join("\n"), /--yes/);
    assert.equal(reset.stderr.join("\n").includes("mesa:mesa"), false);

    const dir = mkdtempSync(join(tmpdir(), "mesa-transfer-"));
    writeFileSync(join(dir, "bad.json"), "{}\n", "utf8");
    const bad = captureIo();
    const code = await runPersistenceCli(
      ["import", "--file", "bad.json"],
      { ...dead, INIT_CWD: dir },
      bad.io,
    );
    assert.equal(code, 1);
    assert.match(bad.stderr.join("\n"), /Export is missing format|format must be/);

    const help = captureIo();
    assert.equal(await runPersistenceCli(["--help"], {}, help.io), 0);
    assert.match(help.stdout.join("\n"), /db:export/);

    const env: NodeJS.ProcessEnv = { DATABASE_URL: "postgres://already@127.0.0.1:5432/keep" };
    applyEnvFile(
      '\uFEFF# comment\r\nexport DATABASE_URL="postgres://from-file@127.0.0.1:5432/file"\r\nOTHER=\r\n',
      env,
    );
    assert.equal(env.DATABASE_URL, "postgres://already@127.0.0.1:5432/keep");
    const empty: NodeJS.ProcessEnv = { DATABASE_URL: "  " };
    applyEnvFile('DATABASE_URL=postgres://mesa:mesa@127.0.0.1:5432/mesa\r\n', empty);
    assert.equal(empty.DATABASE_URL, "postgres://mesa:mesa@127.0.0.1:5432/mesa");
    assert.equal(
      resolveCliPath("mesa-backup.json", { INIT_CWD: "/tmp/from-shell" }),
      resolve("/tmp/from-shell", "mesa-backup.json"),
    );
    assert.equal(resolveCliPath("mesa-backup.json", { INIT_CWD: "  " }), resolve("mesa-backup.json"));
  });

  it("writes an HTTP export with LF newlines", async () => {
    const app = buildApp({ logger: false });
    const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    const dir = mkdtempSync(join(tmpdir(), "mesa-transfer-"));
    const out = join(dir, "backup.json");
    try {
      const captured = captureIo();
      const code = await runPersistenceCli(
        ["export", "--base-url", baseUrl, "--out", "backup.json"],
        { INIT_CWD: dir },
        captured.io,
      );
      assert.equal(code, 0);
      const text = readFileSync(out, "utf8");
      assert.equal(text.includes("\r"), false);
      const parsed = parsePersistenceExportText(text);
      assert.equal(parsed.agents[0]?.agent_id, REFERENCE_AGENT_ID);
      assert.equal(parsed.source, "http");
      assert.match(captured.stdout.join("\n"), /created_at: order/);
    } finally {
      await app.close();
    }
  });
});
