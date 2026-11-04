import type { Agent, AgentInstanceKind, AgentTask, Run, RunPhase, FixKind, Trace } from "@mesa/shared";

const BACKEND = (import.meta.env.VITE_BACKEND_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");

async function backendFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
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

const PLACEHOLDER_TASK = {
  task_id: "T1",
  title: "Default task",
  prompt: "Describe the task this agent should perform.",
  success_test: {
    type: "verifier_checks" as const,
    checks: [{ name: "task_complete", description: "The agent completed the task." }],
  },
};

function draftToBody(draft: AgentDraft): Omit<Agent, "agent_id" | "created_at" | "updated_at"> {
  return {
    name: draft.name,
    description: draft.description || draft.name,
    instance: { kind: draft.instance_kind, base_url: draft.instance_base_url, runtime: "grok" },
    test_instance: { base_url: draft.test_instance_base_url || draft.instance_base_url, runtime: "grok" },
    traces: { store: "path", path_or_url: "pending" },
    docs: { prompt_summary: "", tools: [], constraints: [], config_notes: "" },
    tasks: draft.tasks?.length ? draft.tasks : [PLACEHOLDER_TASK],
  };
}

// --- Runs ---

export interface RunParams {
  phase: RunPhase;
  task_ids?: string[];
  fix_kinds?: FixKind[];
  parent_run_id?: string | null;
}

export async function listRuns(): Promise<Run[]> {
  const data = await backendFetch<{ runs: Run[] }>("/runs");
  return data.runs;
}

export async function getRun(id: string): Promise<Run> {
  return backendFetch<Run>(`/runs/${id}`);
}

export async function createRun(params: RunParams): Promise<Run[]> {
  const body: Record<string, unknown> = { phase: params.phase };
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
