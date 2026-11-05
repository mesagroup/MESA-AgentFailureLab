import type { Agent, AgentTask, Run, Trace, VerifierCheck } from "@mesa/shared";

function firstTraceId(run: Pick<Run, "trace_ids">): string | null {
  const id = run.trace_ids?.[0];
  return id ? id : null;
}

function runHref(runId: string | null | undefined): string | null {
  const id = runId?.trim();
  return id ? `/runs/${encodeURIComponent(id)}` : null;
}

/** List and detail are separate routes. Detail is never the grouped list. */
export const RUNS_LIST_ROUTE = "/runs";
export const RUNS_DETAIL_ROUTE = "/runs/:runId";

export interface RunTaskView {
  task_id: string;
  title: string;
  prompt: string;
  setup_summary: string;
}

export interface RunNotesView {
  title: string;
  body: string;
}

export interface RunVerifierView {
  passed: boolean;
  checks: VerifierCheck[];
}

export type RunDetailBanner =
  | { kind: "error"; message: string }
  | { kind: "running"; message: string }
  | { kind: "queued"; message: string }
  | { kind: "failed"; message: string };

export interface RunDetailView {
  run: Run;
  agent_name: string;
  task: RunTaskView;
  verifier: RunVerifierView | null;
  verifier_empty: string | null;
  notes: RunNotesView | null;
  trace_id: string | null;
  trace_href: string | null;
  analyze_href: string | null;
  trace_empty: string | null;
  started_at: string | null;
  ended_at: string | null;
  banners: RunDetailBanner[];
}

export type RunDetailLoad =
  | { status: "ok"; view: RunDetailView }
  | { status: "not_found"; runId: string; message: string }
  | { status: "error"; runId: string; message: string; httpStatus: number | null };

export interface RunDetailLoaders {
  getRun: (id: string) => Promise<Run>;
  getAgent: (id: string) => Promise<Agent | undefined>;
  getTrace: (id: string) => Promise<Trace>;
}

/** Every run row opens the dedicated detail page, including runs that have a trace. */
export function runListClickHref(run: Pick<Run, "run_id">): string {
  const href = runHref(run.run_id);
  if (!href) return RUNS_LIST_ROUTE;
  return href;
}

export function decodeRunIdParam(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function summarizeSetup(task: AgentTask | undefined): string {
  if (!task) return "No setup is stored on this agent task.";
  const parts: string[] = [];
  const cart = task.setup.cart.length;
  const orders = task.setup.orders.length;
  const perms = task.setup.permissions.length;
  const loans = task.setup.library?.loans.length ?? 0;
  if (cart) parts.push(`${cart} cart line${cart === 1 ? "" : "s"}`);
  if (orders) parts.push(`${orders} seed order${orders === 1 ? "" : "s"}`);
  if (loans) parts.push(`${loans} library loan${loans === 1 ? "" : "s"}`);
  if (perms) parts.push(`permissions: ${task.setup.permissions.join(", ")}`);
  if (parts.length === 0) return "No cart, orders, or extra grants.";
  return parts.join(" · ");
}

export function taskViewFor(run: Pick<Run, "task_id">, agent: Agent | undefined): RunTaskView {
  const task = agent?.tasks.find((item) => item.task_id === run.task_id);
  return {
    task_id: run.task_id,
    title: task?.title ?? run.task_id,
    prompt: task?.prompt ?? "",
    setup_summary: summarizeSetup(task),
  };
}

export function notesFromTrace(trace: Trace | null): RunNotesView | null {
  if (!trace) return null;
  if (trace.diagnosis?.cause) {
    return { title: "Diagnosis note", body: trace.diagnosis.cause };
  }
  if (trace.fault.attacker.used && trace.fault.attacker.payload_id) {
    return { title: "Attacker payload", body: trace.fault.attacker.payload_id };
  }
  return null;
}

export function bannersFor(run: Run, traceError: string | null): RunDetailBanner[] {
  const banners: RunDetailBanner[] = [];
  if (run.status === "error") {
    banners.push({
      kind: "error",
      message: run.error_message?.trim() || "This run ended in an error. No silent empty state.",
    });
  } else if (run.status === "failed") {
    banners.push({
      kind: "failed",
      message: run.error_message?.trim() || "The run finished as failed. Verifier checks are below when a trace exists.",
    });
  } else if (run.status === "running") {
    banners.push({ kind: "running", message: "This run is still running. The page will refresh until it finishes." });
  } else if (run.status === "queued") {
    banners.push({ kind: "queued", message: "This run is queued. The page will refresh until it starts." });
  } else if (run.error_message?.trim()) {
    banners.push({ kind: "error", message: run.error_message.trim() });
  }
  if (traceError) banners.push({ kind: "error", message: traceError });
  return banners;
}

export function buildRunDetailView(input: {
  run: Run;
  agent?: Agent;
  trace?: Trace | null;
  traceError?: string | null;
}): RunDetailView {
  const trace = input.trace ?? null;
  const listedTraceId = firstTraceId(input.run);
  const traceId = trace?.trace_id ?? listedTraceId;
  const verifier = trace?.outcome.verifier
    ? { passed: trace.outcome.verifier.passed, checks: trace.outcome.verifier.checks }
    : null;
  let verifier_empty: string | null = null;
  let trace_empty: string | null = null;
  if (!listedTraceId) {
    trace_empty = "No trace is stored for this run.";
    verifier_empty = "Verifier results appear when a trace is stored. This run has none.";
  } else if (!trace) {
    trace_empty = input.traceError ?? "A trace id is listed, but the trace document was not loaded.";
    verifier_empty = "Verifier checks live on the trace. They are unavailable until GET /traces succeeds.";
  } else if (verifier && verifier.checks.length === 0) {
    verifier_empty = "The trace has an outcome.verifier object, but it lists no individual checks.";
  }

  return {
    run: input.run,
    agent_name: input.agent?.name ?? input.run.agent_id,
    task: taskViewFor(input.run, input.agent),
    verifier,
    verifier_empty,
    notes: notesFromTrace(trace),
    trace_id: traceId,
    trace_href: traceId ? `/traces/${encodeURIComponent(traceId)}` : null,
    analyze_href: traceId ? `/traces/${encodeURIComponent(traceId)}#analysis` : null,
    trace_empty,
    started_at: trace?.started_at ?? null,
    ended_at: trace?.ended_at ?? null,
    banners: bannersFor(input.run, input.traceError ?? null),
  };
}

export function messageFromUnknown(error: unknown): { message: string; httpStatus: number | null } {
  const httpStatus = httpStatusOf(error);
  if (error instanceof Error && error.message) return { message: error.message, httpStatus };
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" && error.message) {
    return { message: error.message, httpStatus };
  }
  return { message: "The run could not be loaded.", httpStatus };
}

function httpStatusOf(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return null;
}

/**
 * Load the dedicated run page.
 * `GET /runs/:id` is the Run document only (no `outcome`). Verifier checks
 * come from `GET /traces/:traceId` when `trace_ids[0]` is set.
 */
export async function loadRunDetail(runId: string, loaders: RunDetailLoaders): Promise<RunDetailLoad> {
  const id = runId.trim();
  if (!id) {
    return { status: "not_found", runId: "", message: "Missing run id." };
  }
  let run: Run;
  try {
    run = await loaders.getRun(id);
  } catch (error) {
    const { message, httpStatus } = messageFromUnknown(error);
    if (httpStatus === 404) return { status: "not_found", runId: id, message };
    return { status: "error", runId: id, message, httpStatus };
  }

  const listedTraceId = firstTraceId(run);
  const [agent, traceResult] = await Promise.all([
    loaders.getAgent(run.agent_id).catch(() => undefined),
    listedTraceId
      ? loaders.getTrace(listedTraceId).then(
          (trace) => ({ trace, error: null as string | null }),
          (error: unknown) => {
            const { message, httpStatus } = messageFromUnknown(error);
            const statusBit = httpStatus != null ? ` (HTTP ${httpStatus})` : "";
            return {
              trace: null,
              error: `This run lists trace ${listedTraceId}, but GET /traces failed${statusBit}: ${message}`,
            };
          },
        )
      : Promise.resolve({ trace: null, error: null as string | null }),
  ]);

  return {
    status: "ok",
    view: buildRunDetailView({
      run,
      agent,
      trace: traceResult.trace,
      traceError: traceResult.error,
    }),
  };
}

export function shouldPollRun(run: Pick<Run, "status"> | undefined): boolean {
  return run?.status === "queued" || run?.status === "running";
}
