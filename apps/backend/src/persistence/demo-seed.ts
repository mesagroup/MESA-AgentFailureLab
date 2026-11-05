import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run, Trace } from "@mesa/shared";
import { remapLibrarySchemaB, remapShopSchemaA, type OtelImportResult } from "@mesa/shared/otel";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import { LIBRARY_AGENT_ID, REFERENCE_AGENT_ID } from "../agents/store.js";
import type { RunStore } from "./store.js";

export type DemoSeedResult = "inserted" | "kept";

export interface DemoSeedReport {
  readonly runs: Readonly<Record<string, DemoSeedResult>>;
  readonly traces: Readonly<Record<string, DemoSeedResult>>;
}

export interface DemoSeedPair {
  readonly run: Run;
  readonly trace: Trace;
}

/**
 * Shop schema A exports from #161. Remapped with `remapShopSchemaA` (no extra lab copies).
 */
const SHOP_SCHEMA_A_EXPORTS = [
  "otel/shop-schema-a/prod-t1-search.json",
  "otel/shop-schema-a/prod-t3-checkout.json",
  "otel/shop-schema-a/test-t2-cart.json",
] as const;

/**
 * Library schema B exports from #163. Remapped with `remapLibrarySchemaB`.
 */
const LIBRARY_SCHEMA_B_EXPORTS = [
  "otel/library-schema-b/prod-renew-loan.json",
  "otel/library-schema-b/test-return-loan.json",
  "otel/library-schema-b/prod-place-hold.json",
] as const;

/**
 * Storyboard scenes 6–8 (`docs/demo-script.md` § E). Hand-written T3 injected
 * checkout with a canned Grok-shaped `diagnosis` + `proposed_fixes`.
 * The injector wrote `fault.*` in the fixture; Grok did not.
 */
const STORYBOARD_RUN_EXAMPLE = "run-injected.json";
const STORYBOARD_TRACE_EXAMPLE = "injected-failed-trace.json";

/** Trace opened in scene 6. Scene 8 replays this run's parent `injection_plan`. */
export const DEMO_STORYBOARD_TRACE_ID = "trace-t3-forged-checkout";
export const DEMO_STORYBOARD_RUN_ID = "run-t3-injected-001";

function examplesDir(): string {
  return dirname(fileURLToPath(import.meta.resolve("@mesa/shared/examples/agent-reference-shop.json")));
}

function readExample(relative: string): unknown {
  return JSON.parse(readFileSync(join(examplesDir(), relative), "utf8")) as unknown;
}

function pairFromRemap(result: OtelImportResult, relative: string, agentId: string): DemoSeedPair {
  if (!result.ok) {
    throw new Error(`Demo seed ${relative} failed remap: ${result.errors.join("; ")}`);
  }
  const trace = result.traces[0];
  const run = result.runs[0];
  if (!trace || !run) {
    throw new Error(`Demo seed ${relative} remapped to no Trace/Run.`);
  }
  if (trace.agent_id !== agentId) {
    throw new Error(`Demo seed trace ${trace.trace_id} has agent_id ${trace.agent_id}, expected ${agentId}.`);
  }
  if (run.run_id !== trace.run_id || run.trace_ids[0] !== trace.trace_id) {
    throw new Error(`Demo seed run ${run.run_id} is not linked to trace ${trace.trace_id}.`);
  }
  return { run, trace: { ...trace, source: "demo_seed" } };
}

function pairFromLabExample(runRelative: string, traceRelative: string): DemoSeedPair {
  const runParsed = validateRun(readExample(runRelative));
  const traceParsed = validateTrace(readExample(traceRelative));
  if (!runParsed.ok) {
    throw new Error(`Demo seed ${runRelative} failed validateRun: ${runParsed.errors.join("; ")}`);
  }
  if (!traceParsed.ok) {
    throw new Error(`Demo seed ${traceRelative} failed validateTrace: ${traceParsed.errors.join("; ")}`);
  }
  const run = runParsed.value;
  const trace = traceParsed.value;
  if (trace.agent_id !== REFERENCE_AGENT_ID) {
    throw new Error(`Demo seed trace ${trace.trace_id} has agent_id ${trace.agent_id}, expected ${REFERENCE_AGENT_ID}.`);
  }
  if (run.run_id !== trace.run_id || run.trace_ids[0] !== trace.trace_id) {
    throw new Error(`Demo seed run ${run.run_id} is not linked to trace ${trace.trace_id}.`);
  }
  if (run.run_id !== DEMO_STORYBOARD_RUN_ID || trace.trace_id !== DEMO_STORYBOARD_TRACE_ID) {
    throw new Error(`Demo storyboard ids drifted: expected ${DEMO_STORYBOARD_RUN_ID} / ${DEMO_STORYBOARD_TRACE_ID}.`);
  }
  if (trace.diagnosis === null || trace.diagnosis.proposed_fixes.length === 0) {
    throw new Error(`Demo storyboard trace ${trace.trace_id} must already include diagnosis.proposed_fixes.`);
  }
  return { run, trace: { ...trace, source: "demo_seed" } };
}

/** Validated demo Run/Trace pairs: OTel remaps, then the diagnosed T3 storyboard pair. */
export function loadDemoSeedDocuments(): DemoSeedPair[] {
  const shop = SHOP_SCHEMA_A_EXPORTS.map((relative) =>
    pairFromRemap(remapShopSchemaA(readExample(relative), { agentId: REFERENCE_AGENT_ID }), relative, REFERENCE_AGENT_ID),
  );
  const library = LIBRARY_SCHEMA_B_EXPORTS.map((relative) =>
    pairFromRemap(
      remapLibrarySchemaB(readExample(relative), { agentId: LIBRARY_AGENT_ID }),
      relative,
      LIBRARY_AGENT_ID,
    ),
  );
  return [...shop, ...library, pairFromLabExample(STORYBOARD_RUN_EXAMPLE, STORYBOARD_TRACE_EXAMPLE)];
}

export const DEMO_SEED_PAIRS: readonly DemoSeedPair[] = loadDemoSeedDocuments();

export const DEMO_SEED_TRACE_IDS: readonly string[] = DEMO_SEED_PAIRS.map((pair) => pair.trace.trace_id);

export const DEMO_SEED_RUN_IDS: readonly string[] = DEMO_SEED_PAIRS.map((pair) => pair.run.run_id);

/**
 * Insert each demo Run and Trace when that id is absent.
 * A present id is left as stored, including a document that no longer matches the fixture.
 * Other runs and traces are not read, rewritten, or deleted.
 */
export async function seedDemoRunsAndTraces(store: RunStore): Promise<DemoSeedReport> {
  const runs: Record<string, DemoSeedResult> = {};
  const traces: Record<string, DemoSeedResult> = {};
  for (const pair of loadDemoSeedDocuments()) {
    if (await store.getRun(pair.run.run_id)) {
      runs[pair.run.run_id] = "kept";
    } else {
      await store.saveRun(pair.run);
      runs[pair.run.run_id] = "inserted";
    }
    if (await store.getTrace(pair.trace.trace_id)) {
      traces[pair.trace.trace_id] = "kept";
    } else {
      await store.saveTrace(pair.trace);
      traces[pair.trace.trace_id] = "inserted";
    }
  }
  return { runs, traces };
}
