import type {
  Agent,
  AgentInstanceKind,
  AgentTask,
  FixKind,
  Run,
  RunPhase,
  Trace,
  TraceOutcome,
  TraceTotals,
} from "@mesa/shared";
import { isJuryReport, type JuryCaseDescription, type JuryCaseReport, type JuryRequestBody } from "./jury";

const BACKEND = (import.meta.env.VITE_BACKEND_URL ?? "/api").replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function backendFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const { message, code } = await errorBody(res);
    throw new ApiError(res.status, message, code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function errorBody(res: Response): Promise<{ message: string; code: string | null }> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) {
      const record = body as { message?: unknown; errors?: unknown; error?: unknown };
      const code = typeof record.error === "string" ? record.error : null;
      if (Array.isArray(record.errors) && record.errors.every((entry) => typeof entry === "string")) {
        return { message: record.errors.join("; "), code };
      }
      if (typeof record.message === "string" && record.message.length > 0) return { message: record.message, code };
      return { message: `${res.status} ${res.statusText}`, code };
    }
  } catch {
    // The error body was not JSON.
  }
  return { message: `${res.status} ${res.statusText}`, code: null };
}

// --- Agents ---

export interface AgentDraft {
  name: string;
  description: string;
  instance_base_url: string;
  test_instance_base_url: string;
  instance_kind: AgentInstanceKind;
  tasks?: AgentTask[];
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
    instance: { ...existing.instance, kind: draft.instance_kind, base_url: draft.instance_base_url },
    test_instance: {
      ...existing.test_instance,
      base_url: draft.test_instance_base_url || draft.instance_base_url,
    },
    tasks: draft.tasks ?? existing.tasks,
  };
  return backendFetch<Agent>(`/agents/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteAgent(id: string): Promise<void> {
  await backendFetch<void>(`/agents/${id}`, { method: "DELETE" });
}

function draftToBody(draft: AgentDraft): Omit<Agent, "agent_id" | "created_at" | "updated_at"> {
  return {
    name: draft.name,
    description: draft.description || draft.name,
    instance: { kind: draft.instance_kind, base_url: draft.instance_base_url, runtime: "grok" },
    test_instance: { base_url: draft.test_instance_base_url || draft.instance_base_url, runtime: "grok" },
    traces: { store: "path", path_or_url: "pending" },
    docs: { prompt_summary: "", tools: [], constraints: [], config_notes: "" },
    tasks: draft.tasks ?? [],
  };
}

// --- Runs ---

export interface RunParams {
  agent_id: string;
  phase: RunPhase;
  task_ids?: string[];
  fix_kinds?: FixKind[];
  parent_run_id?: string | null;
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
  return backendFetch<Run>(`/runs/${id}`);
}

export async function createRun(params: RunParams): Promise<Run[]> {
  const body: Record<string, unknown> = { agent_id: params.agent_id, phase: params.phase };
  if (params.task_ids?.length) body.task_ids = params.task_ids;
  if (params.fix_kinds?.length) body.fix_kinds = params.fix_kinds;
  if (params.parent_run_id !== undefined) body.parent_run_id = params.parent_run_id;
  const data = await backendFetch<{ results: Run[] }>("/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.results;
}

// --- Traces ---

export async function listTraces(): Promise<Trace[]> {
  const data = await backendFetch<{ traces: Trace[] }>("/traces");
  return data.traces;
}

export async function getTrace(id: string): Promise<Trace> {
  return backendFetch<Trace>(`/traces/${id}`);
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
    throw new Error("La risposta non contiene outcome.verifier. Non è un esito del verifier.");
  }
  return report;
}
