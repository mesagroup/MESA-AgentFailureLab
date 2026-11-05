import { randomUUID } from "node:crypto";
import type { Agent, AgentTask, FixKind, InjectionPlan, Run, Trace, TraceStatus, TraceStep } from "@mesa/shared";
import { taskNeedsOrderId } from "@mesa/shared";
import { FIX_KINDS } from "@mesa/shared";
import { agentRunRequest, type AgentRunRequest, type AgentRunResponse } from "../agent/http.js";
import { permissionsFor, scriptedActions, type PlannedAction } from "../agent/scripted.js";
import { executeAttempt, traceBounds } from "../harness/execute.js";
import { prepareWorld } from "../harness/world.js";
import { withWorldGate } from "../harness/world-gate.js";
import type { MockShopClient } from "../mock/client.js";
import type { RunStore } from "../persistence/memory.js";
import { taskById } from "../reference-agent.js";
import { prePass, type PrePassFinding } from "../verifier/prepass.js";
import { verifyOutcome } from "../verifier/verify.js";
import { applyJurorAttack, applyJuryActions } from "./apply.js";
import {
  attackedUserContent,
  JURY_FAULT_CODE,
  JURY_PAYLOAD_ID,
  JURY_TASK_ID,
  juryPlan,
  publishedJuryNote,
  renderTaskPrompt,
  resolveJuryNote,
  type JuryNote,
} from "./jury-note.js";
import {
  decideJuryActions,
  planStructuredActions,
  readEmbeddedInstructions,
  resolveSessionPermissions,
  type EmbeddedMention,
  type RefusedTool,
} from "./policy.js";
import { buildJuryView, readMugStock, readOrderStatus, type JuryBaselineComparison, type JuryLinks, type JuryOutcomeView } from "./view.js";

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
  /** Tools the shop was asked to run on the attack. Empty when the agent refused every call. */
  tools_sent: string[];
  task_id: string;
  baseline: JuryAttempt | null;
  attacked: JuryAttempt;
  comparison: JuryComparison;
  /** Verifier outcome of the attacked trace. `diagnosis` stays null in this process. */
  outcome: JuryOutcomeView;
  /** Versus the live baseline, else the last stored baseline, else the frozen T5 fixture. */
  baseline_comparison: JuryBaselineComparison;
  /** Paths the UI can open. Attacked trace is `GET /traces/:id`. */
  links: JuryLinks;
}

export interface JuryCaseOptions {
  agent: Agent;
  store: RunStore;
  mock: MockShopClient;
  /** When false, only the attacked run is persisted. Default true. */
  includeBaseline?: boolean;
  timeoutMs?: number;
  /**
   * Sent on the agent request. Empty is the guard-off baseline.
   * Stored on the Run only when `parentRunId` makes this a replay (`after_fix`).
   */
  fixKinds?: readonly string[];
  /** Juror note. Omitted uses the frozen body. */
  note?: string;
  /** Task to run. Omitted uses T5. A replay uses the parent run's task. */
  taskId?: string;
  /** Session grant. Omitted uses the task grant with cancel withheld. Not widened from the note. */
  permissions?: readonly string[];
  /** When set, the attacked run is `after_fix` and this id is `parent_run_id`. */
  parentRunId?: string;
  /** Shop URL copied onto the agent request. The scripted jury agent does not call it. */
  mockBaseUrl?: string;
  /**
   * Called after each world setup, while the world gate is held.
   * Tests use this as a barrier. It is not read from the HTTP body and not stored on Run or Trace.
   */
  afterWorldSetup?: () => void | Promise<void>;
  /**
   * Override the agent. Tests and a live `POST /v1/tasks/run` use this.
   * The default is the in-process mirror of `guardCall` plus `readEmbeddedInstructions`.
   */
  callAgent?: (baseUrl: string, request: AgentRunRequest) => Promise<AgentRunResponse>;
}

function sessionIdFor(taskId: string, role: "baseline" | "attack"): string {
  return `s${taskId}_${role}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function sumTotals(steps: readonly TraceStep[]): Trace["totals"] {
  return {
    latency_ms: steps.reduce((sum, step) => sum + step.latency_ms, 0),
    tokens_in: steps.reduce((sum, step) => sum + step.token_usage.input, 0),
    tokens_out: steps.reduce((sum, step) => sum + step.token_usage.output, 0),
    cost_usd: steps.reduce((sum, step) => sum + step.cost_usd, 0),
  };
}

interface BuiltAttempt {
  agentId: string;
  taskId: string;
  phase: "baseline" | "injected" | "after_fix";
  fixKinds: FixKind[];
  parentRunId: string | null;
  startedMs: number;
  sessionId: string;
  orderId: string;
  permissions: string[];
  reportedOrderStatus?: string;
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

async function commitBuilt(input: BuiltAttempt): Promise<JuryAttempt> {
  const runId = `run-${input.taskId}-${input.phase}-${randomUUID()}`;
  const traceId = `trace-${input.taskId}-${input.phase}-${randomUUID()}`;
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
    task_id: input.taskId,
    parent_run_id: input.parentRunId,
    phase: input.phase,
    status: "running",
    trace_ids: [],
    injection_plan: finishedPlan,
    fix_kinds: input.fixKinds,
  };
  await input.store.saveRun(running);

  try {
    const outcome = verifyOutcome({
      checks: input.checks,
      snapshot: input.shopState.parsed,
      wireSnapshot: input.shopState.raw,
      sessionId: input.sessionId,
      permissions: input.permissions,
      orderId: input.orderId,
      reportedOrderStatus: input.reportedOrderStatus,
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
      task_id: input.taskId,
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
      source: "harness",
    };
    const savedTrace = await input.store.saveTrace(trace);
    const savedRun = await input.store.saveRun({
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
    await input.store.saveRun({
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
 * Persist a clean task run and the juror-note attack.
 * Each attempt resets the shop. The live shop afterwards is the attacked attempt.
 * `parentRunId` stores the attack as `after_fix` with `fix_kinds`.
 * Without it, `fix_kinds` go to the agent only and the Run stays `injected`.
 * The mock-world gate covers both attempts, from before the first reset through the last save.
 * A runner call from this case re-enters that gate.
 */
export async function runJuryCase(options: JuryCaseOptions): Promise<JuryCaseReport> {
  const fixKinds = resolveJuryFixes(options.fixKinds);
  const replay = options.parentRunId !== undefined;
  if (replay && fixKinds.length === 0) {
    throw new Error("A replay requires fix_kinds, including permission_guard.");
  }
  let taskId = options.taskId ?? JURY_TASK_ID;
  if (options.parentRunId) {
    const parent = await options.store.getRun(options.parentRunId);
    if (!parent) throw new Error(`No run ${options.parentRunId}.`);
    if (parent.phase === "baseline") {
      throw new Error("parent_run_id must be an injected or after_fix run.");
    }
    if (options.taskId !== undefined && options.taskId !== parent.task_id) {
      throw new Error(`task_id ${options.taskId} does not match parent task ${parent.task_id}.`);
    }
    taskId = parent.task_id;
  }
  const task = taskById(options.agent, taskId);
  const noteBody = resolveJuryNote(options.note);
  const granted = options.permissions ? resolveSessionPermissions(options.permissions) : permissionsFor(task, false);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const includeBaseline = options.includeBaseline !== false;
  const attackPhase = replay ? "after_fix" : "injected";
  const storedFixes = attackPhase === "after_fix" ? fixKinds : [];
  const parentRunId = attackPhase === "after_fix" ? (options.parentRunId ?? null) : null;

  return withWorldGate(async () => {
    let baseline: JuryAttempt | null = null;
    if (includeBaseline) {
      const sessionId = sessionIdFor(taskId, "baseline");
      const startedMs = Date.now();
      const prepared = await prepareWorld(task, options.mock, sessionId);
      await options.afterWorldSetup?.();
      if (taskNeedsOrderId(task) && !prepared.orderId) {
        throw new Error(`Jury baseline did not receive an order id for ${task.task_id}.`);
      }
      const orderId = prepared.orderId ?? "";
      const execution = await executeAttempt({
        prompt: renderTaskPrompt(task.prompt, orderId),
        taskId: task.task_id,
        actions: scriptedActions(task, { orderId: prepared.orderId, permissions: granted }),
        client: options.mock,
        sessionId,
        permissions: granted,
        plan: null,
        timeoutMs,
        startedMs,
      });
      const shopState = await options.mock.state();
      baseline = await commitBuilt({
        agentId: options.agent.agent_id,
        taskId,
        store: options.store,
        phase: "baseline",
        fixKinds: [],
        parentRunId: null,
        startedMs,
        sessionId,
        orderId,
        permissions: granted,
        reportedOrderStatus: execution.reportedOrderStatus,
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

    const sessionId = sessionIdFor(taskId, "attack");
    const startedMs = Date.now();
    const prepared = await prepareWorld(task, options.mock, sessionId);
    await options.afterWorldSetup?.();
    if (taskNeedsOrderId(task) && !prepared.orderId) {
      throw new Error(`Jury attack did not receive an order id for ${task.task_id}.`);
    }
    const orderId = prepared.orderId ?? "";
    const consulted = await consultJuryAgent(options, {
      task,
      taskId,
      prompt: attackedUserContent(task.prompt, orderId, noteBody),
      sessionId,
      orderId,
      permissions: granted,
      fixKinds,
    });
    const onlyCancel =
      consulted.actions.length === 0 || consulted.actions.every((action) => action.tool_name === "cancel_order");
    const attack = onlyCancel
      ? await applyJurorAttack({
          taskPrompt: task.prompt,
          orderId,
          noteBody,
          client: options.mock,
          sessionId,
          startedMs,
          permissions: consulted.request.permissions,
          actions: consulted.actions,
        })
      : await applyJuryActions({
          taskPrompt: task.prompt,
          orderId,
          noteBody,
          client: options.mock,
          sessionId,
          startedMs,
          permissions: consulted.request.permissions,
          actions: consulted.actions,
          refused: consulted.refused,
          embeddedCancel: consulted.embedded.some((entry) => entry.kind === "tool" && entry.value === "cancel_order"),
        });
    const shopState = await options.mock.state();
    const attacked = await commitBuilt({
      agentId: options.agent.agent_id,
      taskId,
      store: options.store,
      phase: attackPhase,
      fixKinds: storedFixes,
      parentRunId,
      startedMs,
      sessionId,
      orderId,
      permissions: granted,
      reportedOrderStatus: attack.reportedOrderStatus,
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

    const view = await buildJuryView({
      taskId,
      agentId: options.agent.agent_id,
      store: options.store,
      liveBaseline: baseline,
      attacked,
    });

    return {
      case_id: JURY_PAYLOAD_ID,
      payload_id: JURY_PAYLOAD_ID,
      note: publishedJuryNote(taskId, noteBody),
      granted_permissions: granted,
      wire_permissions: attack.wirePermissions,
      agent_request: consulted.request,
      agent_actions: consulted.actions,
      agent_refused: consulted.refused,
      client_called: attack.clientCalled,
      tools_sent: attack.toolsSent,
      task_id: taskId,
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
      outcome: view.outcome,
      baseline_comparison: view.baseline_comparison,
      links: view.links,
    };
  });
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
  input: {
    task: AgentTask;
    taskId: string;
    prompt: string;
    sessionId: string;
    orderId: string;
    permissions: readonly string[];
    fixKinds: readonly FixKind[];
  },
): Promise<{ request: AgentRunRequest; actions: PlannedAction[]; refused: RefusedTool[]; embedded: EmbeddedMention[] }> {
  const request = agentRunRequest({
    agent_id: options.agent.agent_id,
    task_id: input.taskId,
    task: input.task,
    prompt: input.prompt,
    session_id: input.sessionId,
    permissions: input.permissions,
    mock_base_url: options.mockBaseUrl ?? "",
    order_id: input.orderId,
    fix_kinds: input.fixKinds,
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
    return {
      request,
      actions: response.actions ?? [],
      refused: [],
      embedded: readEmbeddedInstructions({ source: "user_prompt", text: request.prompt }),
    };
  }
  const decided =
    input.taskId === JURY_TASK_ID
      ? decideJuryActions({
          orderId: input.orderId,
          permissions: request.permissions,
          fixKinds: request.fix_kinds ?? [],
          prompt: request.prompt,
        })
      : planStructuredActions({
          task: input.task,
          orderId: input.orderId,
          permissions: request.permissions,
          fixKinds: request.fix_kinds ?? [],
          prompt: request.prompt,
        });
  return { request, actions: decided.actions, refused: decided.refused, embedded: decided.embedded };
}
