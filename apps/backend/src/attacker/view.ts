import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Run, Trace, TraceOutcome } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import type { RunStore } from "../persistence/memory.js";
import { isRecord } from "../util.js";
import { JURY_FIXTURE_PATHS, JURY_TASK_ID } from "./jury-note.js";

export interface JuryLinks {
  /** `GET /traces/:id` for the attacked trace. Always stored. */
  attacked_trace: string;
  attacked_run: string;
  /** Set when the baseline run is in the harness store. Null for a frozen fixture. */
  baseline_trace: string | null;
  baseline_run: string | null;
}

export interface JuryOutcomeView {
  /** Sole pass/fail authority. */
  verifier: TraceOutcome["verifier"];
  success: boolean;
  agent_claimed_success: boolean;
  diagnosis: null;
}

export interface JuryBaselineComparison {
  /** live: this request. last: newest stored baseline. frozen: T5 fixture. none: nothing to compare. */
  source: "live" | "last" | "frozen" | "none";
  task_id: string;
  baseline_verifier_passed: boolean | null;
  attacked_verifier_passed: boolean;
  same_verdict: boolean | null;
  baseline_order_status: string | null;
  attacked_order_status: string;
  baseline_run_id: string | null;
  baseline_trace_id: string | null;
  attacked_run_id: string;
  attacked_trace_id: string;
  baseline_trace_path: string | null;
  attacked_trace_path: string;
  fixture?: {
    run: (typeof JURY_FIXTURE_PATHS)["baseline_run"];
    trace: (typeof JURY_FIXTURE_PATHS)["baseline_trace"];
  };
}

export function tracePath(traceId: string): string {
  return `/traces/${traceId}`;
}

export function runPath(runId: string): string {
  return `/runs/${runId}`;
}

export function readOrderStatus(trace: Trace, orderId: string): string {
  const orders = trace.outcome.verifier.mock_state_snapshot.orders;
  if (!Array.isArray(orders)) return "missing";
  if (orderId.length === 0) {
    for (const entry of orders) {
      if (isRecord(entry) && typeof entry.status === "string") return entry.status;
    }
    return "missing";
  }
  for (const entry of orders) {
    if (!isRecord(entry) || entry.order_id !== orderId) continue;
    if (typeof entry.status === "string") return entry.status;
  }
  return "missing";
}

export function readMugStock(trace: Trace): number | null {
  const inventory = trace.outcome.verifier.mock_state_snapshot.inventory;
  if (!Array.isArray(inventory)) return null;
  for (const entry of inventory) {
    if (!isRecord(entry) || entry.sku !== "SKU-MUG-01") continue;
    if (typeof entry.stock === "number") return entry.stock;
  }
  return null;
}

interface AttemptRef {
  run: Run;
  trace: Trace;
  order_id: string;
}

async function lastStoredBaseline(store: RunStore, taskId: string, agentId: string): Promise<AttemptRef | null> {
  const runs = (await store.listRuns()).filter(
    (run) => run.phase === "baseline" && run.task_id === taskId && run.agent_id === agentId && run.trace_ids.length > 0,
  );
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run) continue;
    const traceId = run.trace_ids[0];
    if (!traceId) continue;
    const trace = await store.getTrace(traceId);
    if (!trace) continue;
    return { run, trace, order_id: "" };
  }
  return null;
}

let frozenBaseline: AttemptRef | null | undefined;

function loadFrozenBaseline(): AttemptRef | null {
  if (frozenBaseline !== undefined) return frozenBaseline;
  const directory = fileURLToPath(new URL("../../fixtures/jury/", import.meta.url));
  const runResult = validateRun(JSON.parse(readFileSync(`${directory}/baseline-run.json`, "utf8")));
  const traceResult = validateTrace(JSON.parse(readFileSync(`${directory}/baseline-trace.json`, "utf8")));
  if (!runResult.ok || !traceResult.ok) {
    const errors = [...(runResult.ok ? [] : runResult.errors), ...(traceResult.ok ? [] : traceResult.errors)];
    throw new Error(`Frozen jury baseline is invalid: ${errors.join("; ")}`);
  }
  frozenBaseline = { run: runResult.value, trace: traceResult.value, order_id: "ord_0001" };
  return frozenBaseline;
}

/**
 * Compare the attacked verifier with a baseline for the same task.
 * A baseline this request just ran wins. Otherwise the newest stored baseline for
 * the agent and task. The T5 fixture is the last resort and is not inserted into the store.
 */
export async function buildJuryView(input: {
  taskId: string;
  agentId: string;
  store: RunStore;
  liveBaseline: AttemptRef | null;
  attacked: AttemptRef;
}): Promise<{ links: JuryLinks; outcome: JuryOutcomeView; baseline_comparison: JuryBaselineComparison }> {
  const attackedPath = tracePath(input.attacked.trace.trace_id);
  const outcome: JuryOutcomeView = {
    verifier: input.attacked.trace.outcome.verifier,
    success: input.attacked.trace.outcome.success,
    agent_claimed_success: input.attacked.trace.outcome.agent_claimed_success,
    diagnosis: null,
  };

  let source: JuryBaselineComparison["source"] = "none";
  let baseline: AttemptRef | null = null;
  let fixture: JuryBaselineComparison["fixture"];
  if (input.liveBaseline) {
    source = "live";
    baseline = input.liveBaseline;
  } else {
    const stored = await lastStoredBaseline(input.store, input.taskId, input.agentId);
    if (stored) {
      source = "last";
      baseline = stored;
    } else if (input.taskId === JURY_TASK_ID) {
      const frozen = loadFrozenBaseline();
      if (frozen) {
        source = "frozen";
        baseline = frozen;
        fixture = {
          run: JURY_FIXTURE_PATHS.baseline_run,
          trace: JURY_FIXTURE_PATHS.baseline_trace,
        };
      }
    }
  }

  const inspectable = source === "live" || source === "last";
  const baselinePassed = baseline ? baseline.trace.outcome.verifier.passed : null;
  const attackedPassed = input.attacked.trace.outcome.verifier.passed;
  const links: JuryLinks = {
    attacked_trace: attackedPath,
    attacked_run: runPath(input.attacked.run.run_id),
    baseline_trace: inspectable && baseline ? tracePath(baseline.trace.trace_id) : null,
    baseline_run: inspectable && baseline ? runPath(baseline.run.run_id) : null,
  };
  const comparison: JuryBaselineComparison = {
    source,
    task_id: input.taskId,
    baseline_verifier_passed: baselinePassed,
    attacked_verifier_passed: attackedPassed,
    same_verdict: baselinePassed === null ? null : baselinePassed === attackedPassed,
    baseline_order_status: baseline ? readOrderStatus(baseline.trace, baseline.order_id) : null,
    attacked_order_status: readOrderStatus(input.attacked.trace, input.attacked.order_id),
    baseline_run_id: baseline?.run.run_id ?? null,
    baseline_trace_id: baseline?.trace.trace_id ?? null,
    attacked_run_id: input.attacked.run.run_id,
    attacked_trace_id: input.attacked.trace.trace_id,
    baseline_trace_path: links.baseline_trace,
    attacked_trace_path: attackedPath,
    ...(fixture ? { fixture } : {}),
  };
  return { links, outcome, baseline_comparison: comparison };
}
