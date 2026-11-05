import { GROK_AGENT_HTTP_TIMEOUT_MS, type AgentRunRequest, type AgentTask, type FixKind } from "@mesa/shared";
import { fetchWithTransientRetry, type TransientFetchOptions } from "../net/transient-fetch.js";
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
export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
}

export interface RefusedAction {
  tool_name: string;
  required: string;
}

/**
 * `executed: false` means the harness must perform `actions` against the mock.
 * `agent` and `fallback` are planner metadata. They are not part of the shared
 * AgentRunRequest contract. A missing key is `fallback: "no_key"`, not an error.
 */
export interface AgentRunResponse {
  executed: boolean;
  claimed_success?: boolean;
  actions?: PlannedAction[];
  steps?: RemoteStep[];
  refused?: RefusedAction[];
  answer?: string;
  usage?: AgentUsage;
  agent?: "scripted" | "grok";
  fallback?: "no_key";
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
  wake?: Pick<TransientFetchOptions, "sleep" | "now" | "budgetMs">,
): Promise<AgentRunResponse> {
  const url = tasksRunUrl(baseUrl);
  const response = await fetchWithTransientRetry(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(agentHttpTimeoutMs(request)),
    },
    { ...wake, label: `Agent service ${requestPath(url)}` },
  );
  if (!response.ok) {
    throw new Error(`Agent ${baseUrl} returned ${response.status}.`);
  }
  const parsed: unknown = await response.json();
  return parseAgentResponse(parsed);
}

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
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
    refused: value.executed ? undefined : parseRefused(value.refused),
    answer: typeof value.answer === "string" ? value.answer : undefined,
    usage: parseUsage(value.usage),
    agent: value.agent === "grok" || value.agent === "scripted" ? value.agent : undefined,
    fallback: value.fallback === "no_key" ? "no_key" : undefined,
  };
}

/** Scripted posts stay at 10s. A grok planner post waits for one model call. */
export function agentHttpTimeoutMs(request: AgentRunRequest): number {
  const agent = (request as AgentRunRequest & { agent?: unknown }).agent;
  return agent === "grok" ? GROK_AGENT_HTTP_TIMEOUT_MS : 10_000;
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

function parseRefused(value: unknown): RefusedAction[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Agent response refused must be an array.");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.tool_name !== "string" || typeof entry.required !== "string") {
      throw new Error("Each refused action needs tool_name and required.");
    }
    return { tool_name: entry.tool_name, required: entry.required };
  });
}

function parseUsage(value: unknown): AgentUsage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Agent response usage must be an object.");
  const input = numberField(value.input_tokens);
  const output = numberField(value.output_tokens);
  const cost = numberField(value.cost_usd);
  const latency = numberField(value.latency_ms);
  if (input === null || output === null || cost === null || latency === null) {
    throw new Error("Agent response usage needs input_tokens, output_tokens, cost_usd, and latency_ms.");
  }
  return { input_tokens: input, output_tokens: output, cost_usd: cost, latency_ms: latency };
}

function numberField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseSteps(value: unknown): RemoteStep[] {
  if (!Array.isArray(value)) throw new Error("Agent response steps must be an array when executed is true.");
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("Each agent step must be an object.");
    return entry as RemoteStep;
  });
}
