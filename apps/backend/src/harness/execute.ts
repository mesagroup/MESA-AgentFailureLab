import type { FaultLabel, FixKind, InjectionPlan, TraceStep } from "@mesa/shared";
import { describeToolCall, type MockShopClient } from "../mock/client.js";
import {
  droppedOutput,
  faultByCode,
  forgedOutput,
  mutatedInput,
  staleOutput,
  type FaultEffect,
} from "../injector/catalog.js";
import { scrubSpoilers } from "../injector/spoilers.js";
import { isRecord } from "../util.js";
import type { AgentUsage } from "../agent/http.js";
import type { PlannedAction } from "../agent/scripted.js";
import {
  backoffMs,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_RETRIES,
  delay,
  isTransientResult,
  retryDecision,
} from "./retry.js";

interface PushArgs {
  type: TraceStep["type"];
  role: TraceStep["role"];
  content?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
}

export interface Execution {
  steps: TraceStep[];
  labels: FaultLabel[];
  timedOut: boolean;
  reportedOrderStatus?: string;
  claimedSuccess: boolean;
}

/**
 * Decision from the agent-service tool hook.
 * `commit` sends the call with the hook's permissions and keeps the shop body.
 * The hook does not write `fault.*` or `outcome.verifier`. The injector does.
 */
export type ToolHookDecision =
  | { readonly action: "passthrough" }
  | { readonly action: "commit"; readonly permissions: readonly string[] };

export interface ToolBoundaryHook {
  decide(input: {
    tool_name: string;
    tool_input: Record<string, unknown>;
    permissions: readonly string[];
  }): ToolHookDecision;
}

function timestamp(startedMs: number, index: number): string {
  return new Date(startedMs + index + 1).toISOString();
}

function isErrorBody(body: unknown): boolean {
  if (!isRecord(body) || typeof body.error !== "string") return false;
  return (
    body.error === "timeout" ||
    body.error === "permission_denied" ||
    body.error === "not_found" ||
    body.error === "invalid_request" ||
    body.error === "conflict" ||
    body.error === "insufficient_stock" ||
    body.error === "error"
  );
}

function statusFromOutput(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.status !== "string") return undefined;
  return body.status;
}

/**
 * Run the planned tool calls against the mock.
 * When `plan` is set, the matching call is rewritten here and the resulting step is labeled.
 * `at_step` matches the trace index of the tool_call or of the tool_result that shows the fault.
 * A skipped call is omitted. The label is attached to the next step, where the omission shows.
 * A plan whose target never runs is labeled on the closing assistant message.
 * Step text does not name the injector. Ground truth stays on the labels returned to the harness.
 */
export async function executeAttempt(args: {
  prompt: string;
  taskId: string;
  actions: PlannedAction[];
  client: MockShopClient;
  sessionId: string;
  permissions: readonly string[];
  plan: InjectionPlan | null;
  timeoutMs: number;
  startedMs: number;
  claimedSuccess?: boolean;
  /** When set, a `commit` decision runs that call and skips the catalog forge/drop for it. */
  toolHook?: ToolBoundaryHook;
  /** Copied from `Run.fix_kinds`. Empty unless this attempt is `after_fix`. */
  fixKinds?: readonly FixKind[];
  /** Test hook. Production waits with `delay`. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseBackoffMs?: number;
  /**
   * Measured model call. Omitted on the scripted planner, which keeps
   * latency 1 and zero tokens and cost on every step.
   */
  usage?: AgentUsage;
  /** Model text used as the closing assistant message. */
  closingAnswer?: string;
  /** `Agent runtime: …` line. Omitted on the historical scripted trace. */
  runtimeLine?: string;
}): Promise<Execution> {
  const steps: TraceStep[] = [];
  const labels: FaultLabel[] = [];
  const seenResults: unknown[] = [];
  let planSpent = false;
  let planLabeled = false;
  let labelNext = false;
  let timedOut = false;

  const definition = args.plan ? faultByCode(args.plan.ground_truth.code) : undefined;
  const effect: FaultEffect | undefined = definition?.effect;
  const target = args.plan?.target;
  const fixKinds = args.fixKinds ?? [];
  const maxRetries = args.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseBackoffMs = args.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const sleep = args.sleep ?? delay;

  function push(partial: PushArgs, modelStep = false): TraceStep {
    const index = steps.length;
    const measured = stepMetrics(args.usage, modelStep);
    const step: TraceStep = {
      step_id: `step-${index}`,
      index,
      type: partial.type,
      timestamp: timestamp(args.startedMs, index),
      role: partial.role,
      latency_ms: measured.latency_ms,
      token_usage: measured.token_usage,
      cost_usd: measured.cost_usd,
    };
    if (partial.content !== undefined) step.content = scrubSpoilers(partial.content);
    if (partial.tool_name !== undefined) step.tool_name = partial.tool_name;
    if (partial.tool_input !== undefined) step.tool_input = scrubSpoilers(partial.tool_input);
    if (partial.tool_output !== undefined) step.tool_output = scrubSpoilers(partial.tool_output);
    steps.push(step);
    if (labelNext) {
      label(step.step_id);
      labelNext = false;
    }
    return step;
  }

  function label(stepId: string): void {
    if (!args.plan) return;
    labels.push({
      category: args.plan.ground_truth.category,
      code: args.plan.ground_truth.code,
      step_id: stepId,
    });
  }

  function targetsAction(toolName: string, callIndex: number, resultIndex: number): boolean {
    if (!args.plan || !target || planSpent || toolName !== target) return false;
    if (args.plan.at_step === undefined) return true;
    return args.plan.at_step === callIndex || args.plan.at_step === resultIndex;
  }

  function considerLabel(stepId: string): void {
    if (planLabeled) return;
    label(stepId);
    planLabeled = true;
  }

  function shouldRetry(tool: string, status: number, body: unknown, dispatched: boolean, completed: number): boolean {
    if (!isTransientResult(status, body)) return false;
    return (
      retryDecision({
        tool,
        dispatched,
        completedAttempts: completed,
        maxRetries,
        fixes: fixKinds,
      }) === "retry"
    );
  }

  async function pause(completed: number): Promise<void> {
    const wait = backoffMs(baseBackoffMs, completed);
    if (wait > 0) await sleep(wait);
  }

  function timedOutNow(): boolean {
    return Date.now() - args.startedMs >= args.timeoutMs;
  }

  push({ type: "message", role: "user", content: args.prompt });
  if (args.runtimeLine) {
    push({ type: "system", role: "system", content: args.runtimeLine });
  }

  for (const action of args.actions) {
    if (timedOutNow()) {
      timedOut = true;
      break;
    }

    const callIndex = steps.length;
    const resultIndex = callIndex + 1;
    const hit = targetsAction(action.tool_name, callIndex, resultIndex);

    if (hit && effect === "skip") {
      planSpent = true;
      labelNext = true;
      continue;
    }

    let completed = 0;
    let injectThis = hit;
    let committed = false;
    let lastOutput: unknown;
    while (true) {
      if (timedOutNow()) {
        timedOut = true;
        break;
      }
      completed += 1;
      const input = injectThis && effect === "mutate_input" ? mutatedInput(action.tool_input) : action.tool_input;
      const callStep = push({
        type: "tool_call",
        role: "assistant",
        tool_name: action.tool_name,
        tool_input: input,
      });
      if (injectThis && effect === "mutate_input") considerLabel(callStep.step_id);

      const decision = args.toolHook?.decide({
        tool_name: action.tool_name,
        tool_input: input,
        permissions: args.permissions,
      });
      if (decision?.action === "commit") {
        const wired = commitPermissions(decision.permissions);
        const httpCall = describeToolCall(action.tool_name, input);
        let transport: { status: number; body: unknown; dispatched: boolean };
        try {
          const response = await args.client.request({
            method: httpCall.method,
            path: httpCall.path,
            sessionId: args.sessionId,
            permissions: wired,
            body: httpCall.body,
          });
          transport = {
            status: response.status,
            body: response.body,
            dispatched: response.status !== 0,
          };
        } catch (error) {
          if (!fixKinds.includes("controlled_retry")) throw error;
          transport = {
            status: 0,
            body: {
              error: "timeout",
              message: error instanceof Error ? error.message : "Shop request failed before a response.",
            },
            dispatched: !(error instanceof TypeError),
          };
        }
        const resultStep = push({
          type: "tool_result",
          role: "tool",
          tool_name: action.tool_name,
          tool_output: transport.body,
        });
        if (injectThis) considerLabel(resultStep.step_id);
        lastOutput = transport.body;
        if (!shouldRetry(action.tool_name, transport.status, transport.body, transport.dispatched, completed)) {
          seenResults.push(transport.body);
          committed = true;
          if (injectThis) planSpent = true;
          break;
        }
        await pause(completed);
        continue;
      }

      if (injectThis && (effect === "forge_output" || effect === "drop")) {
        const dropped = effect === "drop";
        const output = dropped ? droppedOutput() : forgedOutput(target ?? action.tool_name, input);
        const resultStep = push({
          type: "tool_result",
          role: "tool",
          tool_name: action.tool_name,
          tool_output: output,
        });
        considerLabel(resultStep.step_id);
        lastOutput = output;
        const retry = shouldRetry(action.tool_name, dropped ? 0 : 200, output, !dropped, completed);
        if (!retry) {
          seenResults.push(output);
          committed = true;
          planSpent = true;
          break;
        }
        await pause(completed);
        continue;
      }

      const httpCall = describeToolCall(action.tool_name, input);
      let transport: { status: number; body: unknown; dispatched: boolean };
      try {
        const response = await args.client.request({
          method: httpCall.method,
          path: httpCall.path,
          sessionId: args.sessionId,
          permissions: args.permissions,
          body: httpCall.body,
        });
        transport = {
          status: response.status,
          body: response.body,
          dispatched: response.status !== 0,
        };
      } catch (error) {
        if (!fixKinds.includes("controlled_retry")) throw error;
        transport = {
          status: 0,
          body: {
            error: "timeout",
            message: error instanceof Error ? error.message : "Shop request failed before a response.",
          },
          dispatched: !(error instanceof TypeError),
        };
      }

      const replaced = injectThis && effect === "replace_output";
      const output = replaced ? staleOutput(target ?? action.tool_name, transport.body) : transport.body;
      const resultStep = push({
        type: "tool_result",
        role: "tool",
        tool_name: action.tool_name,
        tool_output: output,
      });
      if (replaced) considerLabel(resultStep.step_id);
      lastOutput = output;
      if (!shouldRetry(action.tool_name, transport.status, output, transport.dispatched, completed)) {
        seenResults.push(output);
        committed = true;
        if (injectThis) planSpent = true;
        break;
      }
      await pause(completed);
    }
    if (!committed && lastOutput !== undefined) seenResults.push(lastOutput);
    if (timedOut) break;
  }

  if (!timedOut && Date.now() - args.startedMs >= args.timeoutMs) {
    timedOut = true;
  }

  const claimed = claimedFrom(args, seenResults, timedOut);
  const closing = timedOut
    ? "Stopped: harness timeout."
    : args.closingAnswer !== undefined && args.closingAnswer.trim().length > 0
      ? args.closingAnswer
      : claimed
        ? `Success. ${args.taskId} is done.`
        : `I could not complete ${args.taskId}.`;
  const closingStep = push({ type: "message", role: "assistant", content: closing }, args.usage !== undefined);
  if (args.plan && labels.length === 0) {
    label(closingStep.step_id);
  }

  const reported = lastReportedStatus(steps);
  return {
    steps,
    labels,
    timedOut,
    reportedOrderStatus: reported,
    claimedSuccess: claimed,
  };
}

function stepMetrics(
  usage: AgentUsage | undefined,
  modelStep: boolean,
): { latency_ms: number; token_usage: { input: number; output: number }; cost_usd: number } {
  if (!usage) return { latency_ms: 1, token_usage: { input: 0, output: 0 }, cost_usd: 0 };
  if (!modelStep) return { latency_ms: 0, token_usage: { input: 0, output: 0 }, cost_usd: 0 };
  return {
    latency_ms: Math.max(0, Math.round(usage.latency_ms)),
    token_usage: {
      input: Math.max(0, Math.round(usage.input_tokens)),
      output: Math.max(0, Math.round(usage.output_tokens)),
    },
    cost_usd: usage.cost_usd,
  };
}

function commitPermissions(permissions: readonly string[]): string[] {
  if (permissions.length === 0 || permissions.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error("Tool hook commit requires non-empty permission strings.");
  }
  return permissions.map((entry) => entry.trim());
}

function claimedFrom(
  args: { taskId: string; permissions: readonly string[]; claimedSuccess?: boolean },
  results: readonly unknown[],
  timedOut: boolean,
): boolean {
  if (args.claimedSuccess !== undefined) return args.claimedSuccess;
  if (timedOut) return false;
  if (args.taskId === "T5" && !args.permissions.includes("write:order:cancel")) return true;
  if (results.some((result) => isErrorBody(result))) return false;
  return true;
}

function lastReportedStatus(steps: readonly TraceStep[]): string | undefined {
  let reported: string | undefined;
  for (const step of steps) {
    if (step.type === "tool_result" && step.tool_name === "get_order") {
      reported = statusFromOutput(step.tool_output);
    }
  }
  return reported;
}

export function traceBounds(startedMs: number, stepCount: number): { started_at: string; ended_at: string } {
  return {
    started_at: new Date(startedMs).toISOString(),
    ended_at: new Date(startedMs + stepCount + 1).toISOString(),
  };
}
