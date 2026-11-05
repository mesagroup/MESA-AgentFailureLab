import type {
  Agent,
  AgentTask,
  FixKind,
  InjectionPlan,
  OtelSourceConfig,
  Run,
  RunPhase,
  TaskEvalset,
  Trace,
  TraceOutcome,
  TraceTotals,
} from "@mesa/shared";
import { parseCreateRunResults, type HarnessTaskResult } from "./after-fix";
import type { EvalsetGenerateBody } from "./evalset";
import { isEvalsetProposal } from "./evalset";
import { isJuryReport, type JuryCaseDescription, type JuryCaseReport, type JuryRequestBody } from "./jury";
import { diagnosePath, parseDiagnoseTrace } from "./trace-analysis";
import {
  parseOtelPullCursors,
  parseTraceList,
  parseTracePullResult,
  traceListPath,
  type OtelPullCursors,
  type OtelPullResponse,
  type TraceListFilters,
  type TracePullBody,
} from "./traces";

const BACKEND = (import.meta.env.VITE_BACKEND_URL ?? "/api").replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, message: string, code: string | null, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function backendFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const { message, code, body } = await errorBody(res);
    throw new ApiError(res.status, message, code, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function errorBody(res: Response): Promise<{ message: string; code: string | null; body: unknown }> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) {
      const record = body as { message?: unknown; errors?: unknown; error?: unknown };
      const code = typeof record.error === "string" ? record.error : null;
      if (Array.isArray(record.errors) && record.errors.every((entry) => typeof entry === "string")) {
        return { message: record.errors.join("; "), code, body };
      }
      if (typeof record.message === "string" && record.message.length > 0) return { message: record.message, code, body };
      return { message: `${res.status} ${res.statusText}`, code, body };
    }
    return { message: `${res.status} ${res.statusText}`, code: null, body };
  } catch {
    // The error body was not JSON.
  }
  return { message: `${res.status} ${res.statusText}`, code: null, body: null };
}

// --- Agents ---

export interface AgentDraft {
  name: string;
  description: string;
  instance_base_url: string;
  test_instance_base_url: string;
  github_repo_url?: string;
  tasks?: AgentTask[];
  /**
   * Source to store. `null` drops a stored source on PUT.
   * `undefined` leaves the stored source alone.
   */
  otel?: OtelSourceConfig | null;
}

export async function listAgents(): Promise<Agent[]> {
  const data = await backendFetch<{ agents: Agent[] }>("/agents");
  return data.agents;
}

export async function getAgent(id: string): Promise<Agent | undefined> {
  try {
    return await backendFetch<Agent>(`/agents/${id}`);
  } catch {
    return undefined;
  }
}

export async function saveAgent(draft: AgentDraft): Promise<Agent> {
  return backendFetch<Agent>("/agents", {
    method: "POST",
    body: JSON.stringify(draftToBody(draft)),
  });
}

export async function updateAgent(id: string, draft: AgentDraft): Promise<Agent> {
  const existing = await backendFetch<Agent>(`/agents/${id}`);
  const body: Agent = {
    ...existing,
    name: draft.name,
    description: draft.description,
    // Keep existing instance.kind; FE no longer exposes or mutates kind.
    instance: { ...existing.instance, base_url: draft.instance_base_url },
    test_instance: {
      ...existing.test_instance,
      base_url: draft.test_instance_base_url || draft.instance_base_url,
    },
    tasks: draft.tasks ?? existing.tasks,
  };
  if (draft.otel) body.otel = draft.otel;
  else if (draft.otel === null) delete body.otel;
  if (draft.github_repo_url?.trim()) body.github_repo_url = draft.github_repo_url.trim();
  else delete body.github_repo_url;
  return backendFetch<Agent>(`/agents/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteAgent(id: string): Promise<void> {
  await backendFetch<void>(`/agents/${id}`, { method: "DELETE" });
}

function draftToBody(draft: AgentDraft): Omit<Agent, "agent_id" | "created_at" | "updated_at"> {
  const body: Omit<Agent, "agent_id" | "created_at" | "updated_at"> = {
    name: draft.name,
    description: draft.description || draft.name,
    // Schema still requires instance.kind; create always sends external until shared drops the field.
    instance: { kind: "external", base_url: draft.instance_base_url, runtime: "grok" },
    test_instance: { base_url: draft.test_instance_base_url || draft.instance_base_url, runtime: "grok" },
    traces: { store: "path", path_or_url: "pending" },
    docs: { prompt_summary: "", tools: [], constraints: [], config_notes: "" },
    tasks: draft.tasks ?? [],
  };
  if (draft.otel) body.otel = draft.otel;
  if (draft.github_repo_url?.trim()) body.github_repo_url = draft.github_repo_url.trim();
  return body;
}

export interface OtelImportResult {
  traces: Trace[];
  runs: Run[];
}

export interface EvalsetGenerateResult {
  evalset: TaskEvalset;
}

/**
 * Propose an evalset for one task. The Grok key stays on agentservice.
 * This call does not save the Agent.
 */
export async function generateEvalset(body: EvalsetGenerateBody): Promise<EvalsetGenerateResult> {
  const result = await backendFetch<unknown>("/evalset/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!isEvalsetProposal(result)) {
    throw new ApiError(502, "The model output was not a valid evalset.", "invalid_evalset_response");
  }
  return result;
}

/** Map a version-1 span batch into Traces. Does not send a bearer token. */
export async function importOtelBatch(agentId: string, batch: unknown): Promise<OtelImportResult> {
  return backendFetch<OtelImportResult>(`/agents/${encodeURIComponent(agentId)}/otel/import`, {
    method: "POST",
    body: JSON.stringify(batch),
  });
}

// --- Runs ---

export interface RunParams {
  agent_id: string;
  phase: RunPhase;
  task_ids?: string[];
  fix_kinds?: FixKind[];
  parent_run_id?: string | null;
  /**
   * Omit on after_fix to copy the parent injection_plan.
   * `null` is a clean treated control.
   */
  injection?: InjectionPlan | "preset" | null;
  /** Replaces task.prompt for this run only when non-empty. */
  prompt_override?: string;
}

/** One stored trace as `GET /runs` embeds it. Not a full Trace document. */
export interface HarnessLinkedTrace {
  trace_id: string;
  outcome: TraceOutcome;
  totals: TraceTotals;
  started_at: string;
  ended_at: string;
}

/** `trace_links[i]` describes `runs[i]`. */
export interface RunTraceLink {
  run_id: string;
  /** `trace_ids[0]`, or null when the run has not stored a trace. */
  first_trace_id: string | null;
  /** Stored traces in `trace_ids` order. A missing id is omitted. */
  traces: HarnessLinkedTrace[];
  /** Same as `runs[i].parent_run_id`. Null when this run has no parent link. */
  parent_run_id: string | null;
  /** Later runs in this snapshot whose `parent_run_id` is this run. */
  child_run_ids: string[];
}

/** In-session tallies. `scope` is always `harness_session`, not a 90-day series. */
export interface HarnessSessionCounts {
  scope: "harness_session";
  agents: number;
  runs: number;
  queued: number;
  running: number;
  passed: number;
  failed: number;
  error: number;
}

/**
 * Body of `GET /runs`.
 * Runs are newest first. There is no `result` field; the row verdict is
 * `trace_links[].traces[].outcome.verifier`.
 */
export interface HarnessSnapshot {
  runs: Run[];
  trace_links: RunTraceLink[];
  counts: HarnessSessionCounts;
}

export async function getHarnessSnapshot(): Promise<HarnessSnapshot> {
  return backendFetch<HarnessSnapshot>("/runs");
}

export async function listRuns(): Promise<Run[]> {
  const data = await getHarnessSnapshot();
  return data.runs;
}

export async function getRun(id: string): Promise<Run> {
  return backendFetch<Run>(`/runs/${encodeURIComponent(id)}`);
}

/**
 * `POST /runs`. Each result is `{ run, trace, parent, links }`.
 * injected from baseline: `{ agent_id, phase: "injected", parent_run_id }`.
 * after_fix: `{ agent_id, phase: "after_fix", parent_run_id, fix_kinds }`.
 * Omit `injection` on after_fix to replay the parent fault. Verdict is `outcome.verifier`.
 */
export async function createRun(params: RunParams): Promise<HarnessTaskResult[]> {
  const body: Record<string, unknown> = { agent_id: params.agent_id, phase: params.phase };
  if (params.task_ids?.length) body.task_ids = params.task_ids;
  if (params.fix_kinds?.length) body.fix_kinds = params.fix_kinds;
  if (params.parent_run_id !== undefined) body.parent_run_id = params.parent_run_id;
  if (params.injection !== undefined) body.injection = params.injection;
  if (params.prompt_override !== undefined) body.prompt_override = params.prompt_override;
  const data = await backendFetch<unknown>("/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return parseCreateRunResults(data);
}

export type { HarnessTaskResult };

// --- Traces ---

/** `GET /traces` with optional `agent_id`, `source`, `since`, and `until`. */
export async function listTraceIndex(filters: TraceListFilters): Promise<Trace[]> {
  const built = traceListPath(filters);
  if (!built.ok) throw new ApiError(400, built.message, "invalid_request");
  const data = await backendFetch<unknown>(built.path);
  const parsed = parseTraceList(data);
  if (!parsed.ok) throw new ApiError(502, parsed.message, "invalid_trace_list", data);
  return parsed.traces;
}

export async function listTraces(): Promise<Trace[]> {
  return listTraceIndex({ agentId: "", source: "", from: "", to: "" });
}

/**
 * `POST /agents/:agentId/traces/pull`.
 * Omit `since` so the lab uses `last_pull_at`, or the full seed on the first pull.
 * HTTP 200 still carries `failed` and `errors`.
 */
export async function pullAgentTraces(agentId: string, body: TracePullBody): Promise<OtelPullResponse> {
  const data = await backendFetch<unknown>(`/agents/${encodeURIComponent(agentId)}/traces/pull`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const parsed = parseTracePullResult(data);
  if (!parsed.ok) throw new ApiError(502, parsed.message, "invalid_pull_response", data);
  return parsed.value;
}

/** `GET /agents/:agentId/otel/cursors`. Does not fetch telemetry. */
export async function getOtelPullCursors(agentId: string): Promise<OtelPullCursors> {
  const data = await backendFetch<unknown>(`/agents/${encodeURIComponent(agentId)}/otel/cursors`);
  const parsed = parseOtelPullCursors(data);
  if (!parsed.ok) throw new ApiError(502, parsed.message, "invalid_cursor_response", data);
  return parsed.value;
}

export async function getTrace(id: string): Promise<Trace> {
  return backendFetch<Trace>(`/traces/${encodeURIComponent(id)}`);
}

/**
 * `POST /traces/:traceId/diagnose`. Empty JSON body. The lab reads the stored
 * trace; the browser does not send a document, URL, or force flag.
 */
export async function diagnoseTrace(id: string): Promise<Trace> {
  const data = await backendFetch<unknown>(diagnosePath(id), {
    method: "POST",
    body: JSON.stringify({}),
  });
  const parsed = parseDiagnoseTrace(data);
  if (!parsed.ok) throw new ApiError(502, parsed.message, "invalid_diagnosis_response", data);
  return parsed.trace;
}

/** Case description. Does not start a run. `structured` feeds the form. */
export async function getJuryCase(): Promise<JuryCaseDescription> {
  return backendFetch<JuryCaseDescription>("/attacker/jury-case");
}

/** Launch or replay. `outcome.verifier` is the verdict. `diagnosis` stays null. */
export async function postJuryCase(body: JuryRequestBody): Promise<JuryCaseReport> {
  const report = await backendFetch<unknown>("/attacker/jury-case", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!isJuryReport(report)) {
    throw new Error("The response is missing outcome.verifier. It is not a verifier result.");
  }
  return report;
}
