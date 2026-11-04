import type { AgentRunRequest, AgentTask, FixKind } from "@mesa/shared";
import { isRecord } from "../util.js";
import type { PlannedAction } from "./scripted.js";

/** `POST /v1/tasks/run` body. The interface lives in `@mesa/shared`. */
export type { AgentRunRequest };

/**
 * Build the body for `POST /v1/tasks/run`.
 * `fix_kinds` is omitted when the run has none. `after_fix` sends the saved list.
 */
export function agentRunRequest(input: {
  agent_id: string;
  task_id: string;
  task: AgentTask;
  prompt: string;
  session_id: string;
  permissions: readonly string[];
  mock_base_url: string;
  order_id?: string;
  fix_kinds?: readonly FixKind[];
}): AgentRunRequest {
  const request: AgentRunRequest = {
    agent_id: input.agent_id,
    task_id: input.task_id,
    task: structuredClone(input.task),
    prompt: input.prompt,
    session_id: input.session_id,
    permissions: [...input.permissions],
    mock_base_url: input.mock_base_url,
  };
  if (input.order_id !== undefined && input.order_id.length > 0) request.order_id = input.order_id;
  const fixes = input.fix_kinds ?? [];
  if (fixes.length > 0) request.fix_kinds = [...fixes];
  return request;
}

export interface RemoteStep {
  type?: string;
  role?: string;
  content?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  latency_ms?: number;
  token_usage?: { input?: number; output?: number };
  cost_usd?: number;
}

/**
 * `executed: false` means the harness must perform `actions` against the mock,
 * which is what lets the injector rewrite a call before it hits the shop.
 * `executed: true` means the agent already called the mock; `steps` is the transcript.
 */
export interface AgentRunResponse {
  executed: boolean;
  claimed_success?: boolean;
  actions?: PlannedAction[];
  steps?: RemoteStep[];
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

/** `POST /v1/tasks/run` on an agent origin (`instance.base_url` or `test_instance.base_url`). */
export function tasksRunUrl(baseUrl: string): string {
  return `${trimBase(baseUrl)}/v1/tasks/run`;
}

export async function probeAgent(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${trimBase(baseUrl)}/health`, {
      signal: AbortSignal.timeout(300),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runRemoteAgent(
  baseUrl: string,
  request: AgentRunRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentRunResponse> {
  const response = await fetchImpl(tasksRunUrl(baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Agent ${baseUrl} returned ${response.status}.`);
  }
  const parsed: unknown = await response.json();
  return parseAgentResponse(parsed);
}

export function parseAgentResponse(value: unknown): AgentRunResponse {
  if (!isRecord(value) || typeof value.executed !== "boolean") {
    throw new Error("Agent response must be an object with boolean executed.");
  }
  const claimed = value.claimed_success;
  if (claimed !== undefined && typeof claimed !== "boolean") {
    throw new Error("Agent response claimed_success must be a boolean.");
  }
  const actions = value.executed ? undefined : parseActions(value.actions);
  const steps = value.executed ? parseSteps(value.steps) : undefined;
  return {
    executed: value.executed,
    claimed_success: claimed,
    actions,
    steps,
  };
}

function parseActions(value: unknown): PlannedAction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Agent response actions must be an array.");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.tool_name !== "string" || entry.tool_name.trim().length === 0) {
      throw new Error("Each agent action needs a tool_name.");
    }
    const toolInput = entry.tool_input === undefined ? {} : entry.tool_input;
    if (!isRecord(toolInput)) throw new Error(`Action ${entry.tool_name} tool_input must be an object.`);
    return { tool_name: entry.tool_name, tool_input: toolInput };
  });
}

function parseSteps(value: unknown): RemoteStep[] {
  if (!Array.isArray(value)) throw new Error("Agent response steps must be an array when executed is true.");
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("Each agent step must be an object.");
    return entry as RemoteStep;
  });
}
