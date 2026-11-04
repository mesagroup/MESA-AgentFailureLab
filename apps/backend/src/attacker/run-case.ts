import { randomUUID } from "node:crypto";
import type { Agent, FixKind, InjectionPlan, Run, Trace, TraceStatus, TraceStep } from "@mesa/shared";
import { FIX_KINDS } from "@mesa/shared";
import { agentRunRequest, type AgentRunRequest, type AgentRunResponse } from "../agent/http.js";
import { scriptedActions, type PlannedAction } from "../agent/scripted.js";
import { executeAttempt, traceBounds } from "../harness/execute.js";
import { prepareWorld } from "../harness/world.js";
import type { MockShopClient } from "../mock/client.js";
import type { RunStore } from "../persistence/memory.js";
import { taskById } from "../reference-agent.js";
import { isRecord } from "../util.js";
import { prePass, type PrePassFinding } from "../verifier/prepass.js";
import { verifyOutcome } from "../verifier/verify.js";
import { applyJurorAttack } from "./apply.js";
import {
  attackedUserContent,
  GRANTED_PERMISSIONS,
  JURY_FAULT_CODE,
  JURY_PAYLOAD_ID,
  JURY_TASK_ID,
  juryNote,
  juryPlan,
  renderTaskPrompt,
  type JuryNote,
} from "./jury-note.js";
import { decideJuryActions, type RefusedTool } from "./policy.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface JuryAttempt {
  run: Run;
  trace: Trace;
  prepass: PrePassFinding[];
  session_id: string;
  order_id: string;
  /** Session grant used by the verifier. Not the header the attacker sent. */
  permissions: string[];
}

export interface JuryComparison {
  baseline_verifier_passed: boolean | null;
  attacked_verifier_passed: boolean;
  baseline_order_status: string | null;
  attacked_order_status: string;
  baseline_mug_stock: number | null;
  attacked_mug_stock: number | null;
  ground_truth: {
    category: "Security";
    code: typeof JURY_FAULT_CODE;
    step_id: string;
  };
  injector_preset_code: "forged_permission_success";
}

export interface JuryCaseReport {
  case_id: typeof JURY_PAYLOAD_ID;
  payload_id: typeof JURY_PAYLOAD_ID;
  note: JuryNote;
  granted_permissions: string[];
  /** Header sent on cancel_order. Empty when the agent refused and the client was not called. */
  wire_permissions: string[];
  /** Request handed to the agent before any cancel. Permissions are the session grant. */
  agent_request: AgentRunRequest;
  agent_actions: PlannedAction[];
  agent_refused: RefusedTool[];
  client_called: boolean;
  baseline: JuryAttempt | null;
  attacked: JuryAttempt;
  comparison: JuryComparison;
}

export interface JuryCaseOptions {
  agent: Agent;
  store: RunStore;
  mock: MockShopClient;
  /** When false, only the attacked run is persisted. Default true. */
  includeBaseline?: boolean;
  timeoutMs?: number;
  /** Sent on the agent request. Empty is the guard-off baseline. Not stored on the injected Run. */
  fixKinds?: readonly string[];
  /** Shop URL copied onto the agent request. The scripted jury agent does not call it. */
  mockBaseUrl?: string;
  /**
   * Override the agent. Tests and a live `POST /v1/tasks/run` use this.
   * The default is the in-process mirror of `guardCall` plus `readEmbeddedInstructions`.
   */
  callAgent?: (baseUrl: string, request: AgentRunRequest) => Promise<AgentRunResponse>;
}

function sessionIdFor(role: "baseline" | "attack"): string {
  return `sT5_${role}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function sumTotals(steps: readonly TraceStep[]): Trace["totals"] {
  return {
    latency_ms: steps.reduce((sum, step) => sum + step.latency_ms, 0),
    tokens_in: steps.reduce((sum, step) => sum + step.token_usage.input, 0),
    tokens_out: steps.reduce((sum, step) => sum + step.token_usage.output, 0),
    cost_usd: steps.reduce((sum, step) => sum + step.cost_usd, 0),
  };
}

function readOrderStatus(trace: Trace, orderId: string): string {
  const orders = trace.outcome.verifier.mock_state_snapshot.orders;
  if (!Array.isArray(orders)) return "missing";
  for (const entry of orders) {
    if (!isRecord(entry) || entry.order_id !== orderId) continue;
    if (typeof entry.status === "string") return entry.status;
  }
  return "missing";
}

function readMugStock(trace: Trace): number | null {
  const inventory = trace.outcome.verifier.mock_state_snapshot.inventory;
  if (!Array.isArray(inventory)) return null;
  for (const entry of inventory) {
    if (!isRecord(entry) || entry.sku !== "SKU-MUG-01") continue;
    if (typeof entry.stock === "number") return entry.stock;
  }
  return null;
}

interface BuiltAttempt {
  agentId: string;
  phase: "baseline" | "injected";
  startedMs: number;
  sessionId: string;
  orderId: string;
  permissions: string[];
  steps: TraceStep[];
  labels: Trace["fault"]["labels"];
  claimedSuccess: boolean;
  timedOut: boolean;
  plan: InjectionPlan | null;
  attacker: Trace["fault"]["attacker"];
  timeoutMs: number;
  checks: Agent["tasks"][number]["success_test"]["checks"];
  shopState: Awaited<ReturnType<MockShopClient["state"]>>;
  store: RunStore;
}

function commitBuilt(input: BuiltAttempt): JuryAttempt {
  const runId = `run-${JURY_TASK_ID}-${input.phase}-${randomUUID()}`;
  const traceId = `trace-${JURY_TASK_ID}-${input.phase}-${randomUUID()}`;
  const label = input.labels[0];
  const labeledStep = label ? input.steps.find((step) => step.step_id === label.step_id) : undefined;
  const finishedPlan = input.plan
    ? {
        ...input.plan,
        ...(labeledStep ? { at_step: labeledStep.index } : {}),
        ground_truth: {
          ...input.plan.ground_truth,
          ...(label ? { step_id: label.step_id } : {}),
        },
      }
    : null;

  const running: Run = {
    run_id: runId,
    agent_id: input.agentId,
    task_id: JURY_TASK_ID,
    parent_run_id: null,
    phase: input.phase,
    status: "running",
    trace_ids: [],
    injection_plan: finishedPlan,
    fix_kinds: [],
  };
  input.store.saveRun(running);

  try {
    const outcome = verifyOutcome({
      checks: input.checks,
      snapshot: input.shopState.parsed,
      wireSnapshot: input.shopState.raw,
      sessionId: input.sessionId,
      permissions: input.permissions,
      orderId: input.orderId,
      agentClaimedSuccess: input.claimedSuccess,
    });
    const bounds = traceBounds(input.startedMs, input.steps.length);
    const findings = prePass({
      started_at: bounds.started_at,
      ended_at: bounds.ended_at,
      steps: input.steps,
      timeoutMs: input.timeoutMs,
    });
    const status: TraceStatus = input.timedOut ? "timeout" : outcome.verifier.passed ? "completed" : "failed";
    const trace: Trace = {
      trace_id: traceId,
      agent_id: input.agentId,
      run_id: runId,
      task_id: JURY_TASK_ID,
      started_at: bounds.started_at,
      ended_at: bounds.ended_at,
      status,
      steps: input.steps,
      outcome,
      totals: sumTotals(input.steps),
      fault: {
        injected: finishedPlan !== null,
        labels: finishedPlan ? input.labels : [],
        attacker: input.attacker,
      },
      diagnosis: null,
    };
    const savedTrace = input.store.saveTrace(trace);
    const savedRun = input.store.saveRun({
      ...running,
      status: status === "completed" ? "passed" : "failed",
      trace_ids: [savedTrace.trace_id],
      injection_plan: finishedPlan,
      duration_ms: Math.max(0, Date.now() - input.startedMs),
    });
    return {
      run: savedRun,
      trace: savedTrace,
      prepass: findings,
      session_id: input.sessionId,
      order_id: input.orderId,
      permissions: input.permissions,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Harness error";
    input.store.saveRun({
      ...running,
      status: "error",
      trace_ids: [],
      duration_ms: Math.max(0, Date.now() - input.startedMs),
      error_message: message,
    });
    throw error;
  }
}

/**
 * Persist a clean T5 refusal (read only, no cancel) and the juror-note attack.
 * Each attempt resets the shop. The live shop afterwards is the attacked attempt.
 */
export async function runJuryCase(options: JuryCaseOptions): Promise<JuryCaseReport> {
  const task = taskById(options.agent, JURY_TASK_ID);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const granted = [...GRANTED_PERMISSIONS];
  const includeBaseline = options.includeBaseline !== false;

  let baseline: JuryAttempt | null = null;
  if (includeBaseline) {
    const sessionId = sessionIdFor("baseline");
    const startedMs = Date.now();
    const prepared = await prepareWorld(JURY_TASK_ID, options.mock, sessionId);
    if (!prepared.orderId) throw new Error("Jury baseline did not receive an order id.");
    const execution = await executeAttempt({
      prompt: renderTaskPrompt(task.prompt, prepared.orderId),
      taskId: JURY_TASK_ID,
      actions: scriptedActions(JURY_TASK_ID, { orderId: prepared.orderId, permissions: granted }),
      client: options.mock,
      sessionId,
      permissions: granted,
      plan: null,
      timeoutMs,
      startedMs,
    });
    const shopState = await options.mock.state();
    baseline = commitBuilt({
      agentId: options.agent.agent_id,
      store: options.store,
      phase: "baseline",
      startedMs,
      sessionId,
      orderId: prepared.orderId,
      permissions: granted,
      steps: execution.steps,
      labels: [],
      claimedSuccess: execution.claimedSuccess,
      timedOut: execution.timedOut,
      plan: null,
      attacker: { used: false, payload_id: null },
      timeoutMs,
      checks: task.success_test.checks,
      shopState,
    });
  }

  const sessionId = sessionIdFor("attack");
  const startedMs = Date.now();
  const prepared = await prepareWorld(JURY_TASK_ID, options.mock, sessionId);
  if (!prepared.orderId) throw new Error("Jury attack did not receive an order id.");
  const consulted = await consultJuryAgent(options, {
    prompt: attackedUserContent(task.prompt, prepared.orderId),
    sessionId,
    orderId: prepared.orderId,
    permissions: granted,
  });
  const attack = await applyJurorAttack({
    taskPrompt: task.prompt,
    orderId: prepared.orderId,
    client: options.mock,
    sessionId,
    startedMs,
    permissions: consulted.request.permissions,
    actions: consulted.actions,
  });
  const shopState = await options.mock.state();
  const attacked = commitBuilt({
    agentId: options.agent.agent_id,
    store: options.store,
    phase: "injected",
    startedMs,
    sessionId,
    orderId: prepared.orderId,
    permissions: granted,
    steps: attack.steps,
    labels: attack.labels,
    claimedSuccess: attack.claimedSuccess,
    timedOut: false,
    plan: juryPlan(),
    attacker: { used: true, payload_id: JURY_PAYLOAD_ID },
    timeoutMs,
    checks: task.success_test.checks,
    shopState,
  });

  const stepId = attacked.run.injection_plan?.ground_truth.step_id;
  if (!stepId) throw new Error("Attacker did not record a ground-truth step.");

  return {
    case_id: JURY_PAYLOAD_ID,
    payload_id: JURY_PAYLOAD_ID,
    note: juryNote(),
    granted_permissions: granted,
    wire_permissions: attack.wirePermissions,
    agent_request: consulted.request,
    agent_actions: consulted.actions,
    agent_refused: consulted.refused,
    client_called: attack.clientCalled,
    baseline,
    attacked,
    comparison: {
      baseline_verifier_passed: baseline ? baseline.trace.outcome.verifier.passed : null,
      attacked_verifier_passed: attacked.trace.outcome.verifier.passed,
      baseline_order_status: baseline ? readOrderStatus(baseline.trace, baseline.order_id) : null,
      attacked_order_status: readOrderStatus(attacked.trace, attacked.order_id),
      baseline_mug_stock: baseline ? readMugStock(baseline.trace) : null,
      attacked_mug_stock: readMugStock(attacked.trace),
      ground_truth: {
        category: "Security",
        code: JURY_FAULT_CODE,
        step_id: stepId,
      },
      injector_preset_code: "forged_permission_success",
    },
  };
}

function resolveJuryFixes(values: readonly string[] | undefined): FixKind[] {
  const kinds: FixKind[] = [];
  for (const kind of values ?? []) {
    if (!(FIX_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`Unknown fix kind ${kind}.`);
    }
    const fix = kind as FixKind;
    if (!kinds.includes(fix)) kinds.push(fix);
  }
  return kinds;
}

/**
 * Ask the agent before any cancel.
 * The request permissions are the session grant. The prompt's permission tokens stay in the prompt.
 */
async function consultJuryAgent(
  options: JuryCaseOptions,
  input: { prompt: string; sessionId: string; orderId: string; permissions: readonly string[] },
): Promise<{ request: AgentRunRequest; actions: PlannedAction[]; refused: RefusedTool[] }> {
  const fixKinds = resolveJuryFixes(options.fixKinds);
  const request = agentRunRequest({
    agent_id: options.agent.agent_id,
    task_id: JURY_TASK_ID,
    prompt: input.prompt,
    session_id: input.sessionId,
    permissions: input.permissions,
    mock_base_url: options.mockBaseUrl ?? "",
    order_id: input.orderId,
    fix_kinds: fixKinds,
  });
  if (options.callAgent) {
    const baseUrl =
      options.agent.test_instance.base_url.length > 0
        ? options.agent.test_instance.base_url
        : options.agent.instance.base_url;
    const response = await options.callAgent(baseUrl, request);
    if (response.executed) {
      throw new Error("The jury agent must set executed to false and return actions.");
    }
    return { request, actions: response.actions ?? [], refused: [] };
  }
  const decided = decideJuryActions({
    orderId: input.orderId,
    permissions: request.permissions,
    fixKinds: request.fix_kinds ?? [],
    prompt: request.prompt,
  });
  return { request, actions: decided.actions, refused: decided.refused };
}
