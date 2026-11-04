import type { Run, RunStatus, Trace, TraceOutcome, TraceTotals } from "@mesa/shared";

/**
 * In-process view for the lab dashboard.
 * Runs and traces come from the harness store (memory, or Postgres when `DATABASE_URL` is set).
 * Agent count comes from the agent registry.
 * `outcome.verifier` is copied from each linked trace. This module does not score runs.
 */
export const HARNESS_SESSION_SCOPE = "harness_session" as const;

export interface LinkedTrace {
  trace_id: string;
  outcome: TraceOutcome;
  totals: TraceTotals;
  started_at: string;
  ended_at: string;
}

/** One list row's link to the traces named by `Run.trace_ids`. */
export interface RunTraceLink {
  run_id: string;
  /** `trace_ids[0]`, or null when the run has not written a trace. Open with `GET /traces/:traceId`. */
  first_trace_id: string | null;
  /** Stored traces, in `trace_ids` order. An id with no stored trace is omitted. */
  traces: LinkedTrace[];
}

/** Tallies of records the harness stores currently hold. */
export interface SessionCounts {
  scope: typeof HARNESS_SESSION_SCOPE;
  agents: number;
  runs: number;
  queued: number;
  running: number;
  passed: number;
  failed: number;
  error: number;
}

export interface SessionView {
  /** Stored runs, most recently started first. Each element is a Run document. */
  runs: Run[];
  /** `trace_links[i]` describes `runs[i]`. */
  trace_links: RunTraceLink[];
  counts: SessionCounts;
}

export function sessionView(input: {
  runs: readonly Run[];
  traces: readonly Trace[];
  agentCount: number;
}): SessionView {
  const runs = [...input.runs].reverse();
  return {
    runs,
    trace_links: traceLinks(runs, input.traces),
    counts: sessionCounts(runs, input.agentCount),
  };
}

function traceLinks(runs: readonly Run[], traces: readonly Trace[]): RunTraceLink[] {
  const byId = new Map(traces.map((trace) => [trace.trace_id, trace]));
  return runs.map((run) => ({
    run_id: run.run_id,
    first_trace_id: run.trace_ids[0] ?? null,
    traces: run.trace_ids.flatMap((traceId) => {
      const trace = byId.get(traceId);
      return trace ? [linkedTrace(trace)] : [];
    }),
  }));
}

function linkedTrace(trace: Trace): LinkedTrace {
  return {
    trace_id: trace.trace_id,
    outcome: structuredClone(trace.outcome),
    totals: structuredClone(trace.totals),
    started_at: trace.started_at,
    ended_at: trace.ended_at,
  };
}

function sessionCounts(runs: readonly Run[], agentCount: number): SessionCounts {
  const tally: Record<RunStatus, number> = {
    queued: 0,
    running: 0,
    passed: 0,
    failed: 0,
    error: 0,
  };
  for (const run of runs) tally[run.status] += 1;
  return {
    scope: HARNESS_SESSION_SCOPE,
    agents: agentCount,
    runs: runs.length,
    ...tally,
  };
}
