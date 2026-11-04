import type { FaultLabel, InjectionPlan, TraceStep } from "@mesa/shared";
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
import type { PlannedAction } from "../agent/scripted.js";

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
}): Promise<Execution> {
  const steps: TraceStep[] = [];
  const labels: FaultLabel[] = [];
  const seenResults: unknown[] = [];
  let injectionUsed = false;
  let labelNext = false;
  let timedOut = false;

  const definition = args.plan ? faultByCode(args.plan.ground_truth.code) : undefined;
  const effect: FaultEffect | undefined = definition?.effect;
  const target = args.plan?.target;

  function push(partial: PushArgs): TraceStep {
    const index = steps.length;
    const step: TraceStep = {
      step_id: `step-${index}`,
      index,
      type: partial.type,
      timestamp: timestamp(args.startedMs, index),
      role: partial.role,
      latency_ms: 1,
      token_usage: { input: 0, output: 0 },
      cost_usd: 0,
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

  function matches(toolName: string, callIndex: number, resultIndex: number): boolean {
    if (!args.plan || !target || injectionUsed || toolName !== target) return false;
    if (args.plan.at_step === undefined) return true;
    return args.plan.at_step === callIndex || args.plan.at_step === resultIndex;
  }

  push({ type: "message", role: "user", content: args.prompt });

  for (const action of args.actions) {
    if (Date.now() - args.startedMs >= args.timeoutMs) {
      timedOut = true;
      break;
    }

    const callIndex = steps.length;
    const resultIndex = callIndex + 1;
    const hit = matches(action.tool_name, callIndex, resultIndex);

    if (hit && effect === "skip") {
      injectionUsed = true;
      labelNext = true;
      continue;
    }

    const input = hit && effect === "mutate_input" ? mutatedInput(action.tool_input) : action.tool_input;
    if (hit && effect === "mutate_input") injectionUsed = true;

    const callStep = push({
      type: "tool_call",
      role: "assistant",
      tool_name: action.tool_name,
      tool_input: input,
    });
    if (hit && effect === "mutate_input") label(callStep.step_id);

    if (hit && (effect === "forge_output" || effect === "drop")) {
      injectionUsed = true;
      const output = effect === "drop" ? droppedOutput() : forgedOutput(target ?? action.tool_name, input);
      const resultStep = push({
        type: "tool_result",
        role: "tool",
        tool_name: action.tool_name,
        tool_output: output,
      });
      seenResults.push(output);
      label(resultStep.step_id);
      continue;
    }

    const httpCall = describeToolCall(action.tool_name, input);
    const response = await args.client.request({
      method: httpCall.method,
      path: httpCall.path,
      sessionId: args.sessionId,
      permissions: args.permissions,
      body: httpCall.body,
    });

    const output =
      hit && effect === "replace_output" ? staleOutput(target ?? action.tool_name, response.body) : response.body;
    const resultStep = push({
      type: "tool_result",
      role: "tool",
      tool_name: action.tool_name,
      tool_output: output,
    });
    seenResults.push(output);
    if (hit && effect === "replace_output") {
      injectionUsed = true;
      label(resultStep.step_id);
    }
  }

  if (!timedOut && Date.now() - args.startedMs >= args.timeoutMs) {
    timedOut = true;
  }

  const claimed = claimedFrom(args, seenResults, timedOut);
  const closing = timedOut
    ? "Stopped: harness timeout."
    : claimed
      ? `Success. ${args.taskId} is done.`
      : `I could not complete ${args.taskId}.`;
  const closingStep = push({ type: "message", role: "assistant", content: closing });
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
