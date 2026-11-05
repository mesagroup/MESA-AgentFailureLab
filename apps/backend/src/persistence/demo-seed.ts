import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run, Trace } from "@mesa/shared";
import { LIBRARY_AGENT_ID, REFERENCE_AGENT_ID } from "../agents/store.js";
import { assertRun, assertTrace, type RunStore } from "./store.js";

export type DemoSeedResult = "inserted" | "kept";

export interface DemoSeedReport {
  runs: Readonly<Record<string, DemoSeedResult>>;
  traces: Readonly<Record<string, DemoSeedResult>>;
}

export interface DemoSeedDocument {
  run: Run;
  trace: Trace;
  createdAt: string;
}

const examplesRoot = dirname(fileURLToPath(import.meta.resolve("@mesa/shared/examples/agent-reference-shop.json")));

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(examplesRoot, relativePath), "utf8")) as unknown;
}

function loadTrace(relativePath: string): Trace {
  return assertTrace(readJson(relativePath) as Trace);
}

function remapTrace(source: Trace, traceId: string, runId: string): Trace {
  return assertTrace({ ...source, trace_id: traceId, run_id: runId });
}

function runForTrace(trace: Trace): Run {
  return assertRun({
    run_id: trace.run_id,
    agent_id: trace.agent_id,
    task_id: trace.task_id,
    parent_run_id: null,
    phase: "baseline",
    status: trace.outcome.verifier.passed ? "passed" : "failed",
    trace_ids: [trace.trace_id],
    injection_plan: null,
    fix_kinds: [],
    duration_ms: trace.totals.latency_ms,
  });
}

function pair(trace: Trace): DemoSeedDocument {
  return { run: runForTrace(trace), trace, createdAt: trace.started_at };
}

/**
 * Demo runs and traces for `reference-shop` and `external-library`.
 * Shop T1/T3 reuse the production import fixtures with remapped ids.
 * Shop T2 and the library traces are files under `packages/shared/examples/demo`.
 */
export function loadDemoSeedDocuments(): DemoSeedDocument[] {
  const shopT1 = remapTrace(loadTrace("production/t1-search-product.json"), "trace-demo-shop-t1", "run-demo-shop-t1");
  const shopT2 = loadTrace("demo/shop-t2-add-cart.json");
  const shopT3 = remapTrace(loadTrace("production/t3-checkout.json"), "trace-demo-shop-t3", "run-demo-shop-t3");
  const libraryRenew = loadTrace("demo/library-renew-loan.json");
  const libraryReturn = loadTrace("demo/library-return-loan.json");
  const libraryHold = loadTrace("demo/library-place-hold.json");
  const documents = [shopT1, shopT2, shopT3, libraryRenew, libraryReturn, libraryHold].map(pair);
  for (const document of documents) {
    if (document.trace.agent_id !== REFERENCE_AGENT_ID && document.trace.agent_id !== LIBRARY_AGENT_ID) {
      throw new Error(`Demo trace ${document.trace.trace_id} is not a demo agent.`);
    }
    if (document.trace.fault.injected || document.trace.fault.labels.length > 0) {
      throw new Error(`Demo trace ${document.trace.trace_id} must not invent fault.labels.`);
    }
    if (document.trace.diagnosis !== null) {
      throw new Error(`Demo trace ${document.trace.trace_id} must leave diagnosis null.`);
    }
    if (document.run.injection_plan !== null || document.run.fix_kinds.length > 0) {
      throw new Error(`Demo run ${document.run.run_id} must be a baseline with no injection.`);
    }
  }
  return documents;
}

/**
 * Insert each demo run and trace when that id is absent.
 * An existing row is kept, including a user-edited copy of a demo id.
 * Other runs and traces are never deleted.
 */
export async function seedDemoRunsAndTraces(store: RunStore): Promise<DemoSeedReport> {
  const runs: Record<string, DemoSeedResult> = {};
  const traces: Record<string, DemoSeedResult> = {};
  for (const document of loadDemoSeedDocuments()) {
    const existingRun = await store.getRun(document.run.run_id);
    if (existingRun) {
      runs[document.run.run_id] = "kept";
    } else {
      await store.upsertImportedRun(document.run, document.createdAt);
      runs[document.run.run_id] = "inserted";
    }
    const existingTrace = await store.getTrace(document.trace.trace_id);
    if (existingTrace) {
      traces[document.trace.trace_id] = "kept";
    } else {
      await store.upsertImportedTrace(document.trace, document.createdAt);
      traces[document.trace.trace_id] = "inserted";
    }
  }
  return { runs, traces };
}
