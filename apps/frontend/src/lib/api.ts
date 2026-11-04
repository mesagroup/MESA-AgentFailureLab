import type {
  Agent,
  AgentInstanceKind,
  AgentTask,
  FaultCategory,
  OtelSourceConfig,
  Run,
  Trace,
  TraceOutcome,
  TraceTotals,
} from "@mesa/shared";
import { ApiError } from "@/lib/errors";
import { runRequestBody, runsFromCreateResponse, type RunParams } from "@/lib/run-request";

export type { RunParams } from "@/lib/run-request";

const BACKEND = (import.meta.env.VITE_BACKEND_URL ?? "/api").replace(/\/$/, "");

async function backendFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) throw await apiError(res);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function apiError(res: Response): Promise<ApiError> {
  let code: string | undefined;
  let message = "";
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) {
      const record = body as { message?: unknown; errors?: unknown; error?: unknown };
      if (typeof record.error === "string" && record.error.length > 0) code = record.error;
      if (Array.isArray(record.errors) && record.errors.every((entry) => typeof entry === "string")) {
        message = record.errors.join("; ");
      } else if (typeof record.message === "string") {
        message = record.message;
      }
    }
  } catch {
    // The error body was not JSON.
  }
  if (!message) message = code || res.statusText || "The request failed.";
  return new ApiError(res.status, message, code);
}

// --- Agents ---

export interface AgentDraft {
  name: string;
  description: string;
  instance_base_url: string;
  test_instance_base_url: string;
  instance_kind: AgentInstanceKind;
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

export async function getAgent(id: string): Promise<Agent> {
  return backendFetch<Agent>(`/agents/${encodeURIComponent(id)}`);
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
  if (draft.otel) body.otel = draft.otel;
  else if (draft.otel === null) delete body.otel;
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
    instance: { kind: draft.instance_kind, base_url: draft.instance_base_url, runtime: "grok" },
    test_instance: { base_url: draft.test_instance_base_url || draft.instance_base_url, runtime: "grok" },
    traces: { store: "path", path_or_url: "pending" },
    docs: { prompt_summary: "", tools: [], constraints: [], config_notes: "" },
    tasks: draft.tasks ?? [],
  };
  if (draft.otel) body.otel = draft.otel;
  return body;
}

export interface OtelImportResult {
  traces: Trace[];
  runs: Run[];
}

/** Map a version-1 span batch into Traces. Does not send a bearer token. */
export async function importOtelBatch(agentId: string, batch: unknown): Promise<OtelImportResult> {
  return backendFetch<OtelImportResult>(`/agents/${encodeURIComponent(agentId)}/otel/import`, {
    method: "POST",
    body: JSON.stringify(batch),
  });
}

// --- Runs ---

export interface FaultCatalogEntry {
  code: string;
  category: FaultCategory;
  target: string;
  fault: string;
  effect: string;
}

export interface FaultCatalog {
  faults: FaultCatalogEntry[];
  presets: Record<string, string>;
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

export async function listFaults(): Promise<FaultCatalog> {
  return backendFetch<FaultCatalog>("/faults");
}

export async function createRun(params: RunParams): Promise<Run[]> {
  const data = await backendFetch<unknown>("/runs", {
    method: "POST",
    body: JSON.stringify(runRequestBody(params)),
  });
  return runsFromCreateResponse(data);
}

export async function diagnoseTrace(id: string): Promise<Trace> {
  return backendFetch<Trace>(`/traces/${encodeURIComponent(id)}/diagnose`, {
    method: "POST",
    body: "{}",
  });
}

// --- Traces ---

export async function listTraces(): Promise<Trace[]> {
  const data = await backendFetch<{ traces: Trace[] }>("/traces");
  return data.traces;
}

export async function getTrace(id: string): Promise<Trace> {
  return backendFetch<Trace>(`/traces/${id}`);
}
