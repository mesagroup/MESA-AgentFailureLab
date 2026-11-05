import { isFixKind, type FixKind, type Run, type Trace, type TraceOutcome, type TraceTotals } from "@mesa/shared";

export const AFTER_FIX_PHASE = "after_fix" as const;

/** Bookmarkable before/after block on `/traces/:traceId`. */
export const AFTER_FIX_SECTION_ID = "after-fix";

/** Storyboard scene 8 (`docs/demo-script.md` § E). */
export const STORYBOARD_AFTER_FIX = {
  traceId: "trace-t3-forged-checkout",
  parentRunId: "run-t3-injected-001",
  agentId: "reference-shop",
  taskId: "T3",
  fault: "forged_tool_result",
  fixKind: "pre_response_check",
} as const;

export const FIX_KIND_LABELS: Record<FixKind, string> = {
  controlled_retry: "Safe retry",
  pre_response_check: "Check before reply",
  permission_guard: "Permission check",
};

/** Paths on `POST /runs` `results[i].links`. */
export interface RunResultLinks {
  run: string;
  trace: string | null;
  parent_run: string | null;
  parent_trace: string | null;
}

export interface HarnessTaskResult {
  run: Run;
  trace: Trace | null;
  parent: { run: Run; trace: Trace | null } | null;
  links: RunResultLinks | null;
}

/**
 * `POST /runs` after_fix body.
 * Omit `injection` so the harness copies the parent's injection_plan.
 * `injection: null` is a clean treated control.
 * Omit `task_ids` so the harness uses the parent's task.
 */
export interface AfterFixRunBody {
  agent_id: string;
  phase: typeof AFTER_FIX_PHASE;
  parent_run_id: string;
  fix_kinds: FixKind[];
  injection?: null;
}

export interface ParentChildLinks {
  parent_run_id: string | null;
  child_run_id: string | null;
  parent_trace_id: string | null;
  child_trace_id: string | null;
}

export interface CheckCompareRow {
  name: string;
  beforePassed: boolean | null;
  afterPassed: boolean | null;
  beforeDetail: string;
  afterDetail: string;
  regression: boolean;
  recovered: boolean;
}

export interface BeforeAfterView {
  beforePassed: boolean | null;
  afterPassed: boolean | null;
  checks: CheckCompareRow[];
  regressions: string[];
  recovered: string[];
  timing: {
    latency_ms: { before: number | null; after: number | null };
    duration_ms: { before: number | null; after: number | null };
    cost_usd: { before: number | null; after: number | null };
  };
}

/** MVP FixKinds from `diagnosis.proposed_fixes`. There is no `fault_kinds`. */
export function selectableFixKinds(proposed: readonly string[] | null | undefined): FixKind[] {
  const out: FixKind[] = [];
  for (const item of proposed ?? []) {
    if (!isFixKind(item) || out.includes(item)) continue;
    out.push(item);
  }
  return out;
}

export function toggleFixKind(selected: readonly FixKind[], kind: FixKind): FixKind[] {
  return selected.includes(kind) ? selected.filter((entry) => entry !== kind) : [...selected, kind];
}

export function afterFixRunBody(input: {
  agentId: string;
  parentRunId: string;
  fixKinds: readonly string[];
  /** When true, send `injection: null` (clean treated). Default omits the field. */
  cleanTreated?: boolean;
}): { ok: true; body: AfterFixRunBody } | { ok: false; message: string } {
  const fix_kinds = selectableFixKinds(input.fixKinds);
  if (fix_kinds.length === 0) {
    return { ok: false, message: "Select at least one proposed fix." };
  }
  const parent_run_id = input.parentRunId.trim();
  if (!parent_run_id) return { ok: false, message: "An earlier run is required." };
  const agent_id = input.agentId.trim();
  if (!agent_id) return { ok: false, message: "An agent is required." };
  const body: AfterFixRunBody = {
    agent_id,
    phase: AFTER_FIX_PHASE,
    parent_run_id,
    fix_kinds,
  };
  if (input.cleanTreated) body.injection = null;
  return { ok: true, body };
}

export function firstTraceId(run: Pick<Run, "trace_ids"> | null | undefined): string | null {
  const id = run?.trace_ids?.[0];
  return id ? id : null;
}

export function runHref(runId: string | null | undefined): string | null {
  const id = runId?.trim();
  return id ? `/runs/${encodeURIComponent(id)}` : null;
}

export function traceHref(traceId: string | null | undefined): string | null {
  const id = traceId?.trim();
  return id ? `/traces/${encodeURIComponent(id)}` : null;
}

export function childRunsOf(runs: readonly Run[], parentRunId: string): Run[] {
  return runs.filter((run) => run.parent_run_id === parentRunId);
}

export function parentChildLinks(input: {
  parentRun?: Pick<Run, "run_id" | "trace_ids"> | null;
  childRun?: Pick<Run, "run_id" | "trace_ids" | "parent_run_id"> | null;
  parentTrace?: Pick<Trace, "trace_id"> | null;
  childTrace?: Pick<Trace, "trace_id"> | null;
  links?: Partial<RunResultLinks> | Record<string, unknown> | null;
}): ParentChildLinks {
  const fromLinks = parseLinkIds(input.links);
  return {
    parent_run_id: fromLinks.parent_run_id ?? nullish(input.childRun?.parent_run_id) ?? input.parentRun?.run_id ?? null,
    child_run_id: fromLinks.child_run_id ?? input.childRun?.run_id ?? null,
    parent_trace_id: fromLinks.parent_trace_id ?? input.parentTrace?.trace_id ?? firstTraceId(input.parentRun),
    child_trace_id: fromLinks.child_trace_id ?? input.childTrace?.trace_id ?? firstTraceId(input.childRun),
  };
}

function nullish(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseLinkIds(links?: Record<string, unknown> | null): ParentChildLinks {
  const empty: ParentChildLinks = {
    parent_run_id: null,
    child_run_id: null,
    parent_trace_id: null,
    child_trace_id: null,
  };
  if (!links) return empty;
  return {
    parent_run_id: idFrom(links.parent_run_id) ?? idFromPath(links.parent_run, "/runs/"),
    child_run_id: idFrom(links.child_run_id) ?? idFromPath(links.run, "/runs/") ?? idFromPath(links.child_run, "/runs/"),
    parent_trace_id: idFrom(links.parent_trace_id) ?? idFromPath(links.parent_trace, "/traces/"),
    child_trace_id: idFrom(links.child_trace_id) ?? idFromPath(links.trace, "/traces/") ?? idFromPath(links.child_trace, "/traces/"),
  };
}

function idFrom(value: unknown): string | null {
  return typeof value === "string" ? nullish(value) : null;
}

function idFromPath(value: unknown, prefix: string): string | null {
  if (typeof value !== "string") return null;
  const escaped = prefix.replaceAll("/", "\\/");
  const match = value.match(new RegExp(`${escaped}([^/?#\\s]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function parseCreateRunResults(body: unknown): HarnessTaskResult[] {
  if (!body || typeof body !== "object") return [];
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const out: HarnessTaskResult[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const record = item as {
      run?: unknown;
      trace?: unknown;
      parent?: unknown;
      links?: unknown;
    };
    if (!isRun(record.run)) continue;
    const parentRecord = record.parent && typeof record.parent === "object" ? (record.parent as { run?: unknown; trace?: unknown }) : null;
    out.push({
      run: record.run,
      trace: isTrace(record.trace) ? record.trace : null,
      parent: parentRecord && isRun(parentRecord.run)
        ? { run: parentRecord.run, trace: isTrace(parentRecord.trace) ? parentRecord.trace : null }
        : null,
      links: parseRunResultLinks(record.links),
    });
  }
  return out;
}

function parseRunResultLinks(value: unknown): RunResultLinks | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.run !== "string") return null;
  return {
    run: record.run,
    trace: typeof record.trace === "string" ? record.trace : null,
    parent_run: typeof record.parent_run === "string" ? record.parent_run : null,
    parent_trace: typeof record.parent_trace === "string" ? record.parent_trace : null,
  };
}

function isRun(value: unknown): value is Run {
  return Boolean(value && typeof value === "object" && typeof (value as Run).run_id === "string");
}

function isTrace(value: unknown): value is Trace {
  return Boolean(value && typeof value === "object" && typeof (value as Trace).trace_id === "string");
}

export function compareBeforeAfter(input: {
  before?: {
    verifier?: TraceOutcome["verifier"] | null;
    totals?: TraceTotals | null;
    duration_ms?: number | null;
  } | null;
  after?: {
    verifier?: TraceOutcome["verifier"] | null;
    totals?: TraceTotals | null;
    duration_ms?: number | null;
  } | null;
}): BeforeAfterView {
  const beforeChecks = input.before?.verifier?.checks ?? [];
  const afterChecks = input.after?.verifier?.checks ?? [];
  const names = unique([...beforeChecks.map((check) => check.name), ...afterChecks.map((check) => check.name)]);
  const checks: CheckCompareRow[] = names.map((name) => {
    const before = beforeChecks.find((check) => check.name === name);
    const after = afterChecks.find((check) => check.name === name);
    const beforePassed = before ? before.passed : null;
    const afterPassed = after ? after.passed : null;
    return {
      name,
      beforePassed,
      afterPassed,
      beforeDetail: before?.detail ?? "",
      afterDetail: after?.detail ?? "",
      regression: beforePassed === true && afterPassed === false,
      recovered: beforePassed === false && afterPassed === true,
    };
  });
  return {
    beforePassed: input.before?.verifier ? input.before.verifier.passed : null,
    afterPassed: input.after?.verifier ? input.after.verifier.passed : null,
    checks,
    regressions: checks.filter((check) => check.regression).map((check) => check.name),
    recovered: checks.filter((check) => check.recovered).map((check) => check.name),
    timing: {
      latency_ms: {
        before: numberOrNull(input.before?.totals?.latency_ms),
        after: numberOrNull(input.after?.totals?.latency_ms),
      },
      duration_ms: {
        before: numberOrNull(input.before?.duration_ms),
        after: numberOrNull(input.after?.duration_ms),
      },
      cost_usd: {
        before: numberOrNull(input.before?.totals?.cost_usd),
        after: numberOrNull(input.after?.totals?.cost_usd),
      },
    },
  };
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatCostUsd(usd: number | null): string {
  if (usd === null) return "—";
  if (usd === 0) return "$0";
  return usd < 0.001 ? `$${(usd * 1000).toFixed(2)}m` : `$${usd.toFixed(4)}`;
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "—";
  return `${(ms / 1000).toFixed(2)}s`;
}

export function passedWord(value: boolean | null): string {
  if (value === null) return "—";
  return value ? "passed" : "failed";
}

/** Headline for the before/after card. Null when a side is still missing. */
export function beforeAfterHeadline(view: BeforeAfterView): string | null {
  if (view.beforePassed === null || view.afterPassed === null) return null;
  if (view.beforePassed === false && view.afterPassed === true) {
    return "Checks recovered: failed → passed";
  }
  if (view.beforePassed === true && view.afterPassed === true) {
    return "Checks passed before and after";
  }
  if (view.beforePassed === true && view.afterPassed === false) {
    return "Checks regressed: passed → failed";
  }
  return "Checks still failed after replay";
}
