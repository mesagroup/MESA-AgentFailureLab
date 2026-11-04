import { randomUUID } from "node:crypto";
import type { Agent, FixKind, InjectionPlan, Run, RunPhase, Trace, TraceStatus } from "@mesa/shared";
import { FIX_KINDS } from "@mesa/shared";
import { agentRunRequest, probeAgent, runRemoteAgent, type AgentRunResponse } from "../agent/http.js";
import { permissionsFor, scriptedActions, type PlannedAction } from "../agent/scripted.js";
import { normalizePlan, presetPlan } from "../injector/catalog.js";
import type { MockShopClient } from "../mock/client.js";
import { ContractError, type RunStore } from "../persistence/memory.js";
import { taskById } from "../reference-agent.js";
import { prePass, type PrePassFinding } from "../verifier/prepass.js";
import { verifyOutcome } from "../verifier/verify.js";
import { executeAttempt, traceBounds, type ToolBoundaryHook } from "./execute.js";
import { prepareWorld } from "./world.js";
import { withWorldGate } from "./world-gate.js";

export type DriverMode = "scripted" | "http" | "auto";
export type InjectionRequest = "preset" | null | InjectionPlan | Record<string, unknown>;

export interface RunTasksOptions {
  agent: Agent;
  store: RunStore;
  mock: MockShopClient;
  mockBaseUrl: string;
  phase: RunPhase;
  taskIds?: string[];
  driver?: DriverMode;
  injection?: InjectionRequest;
  fixKinds?: readonly string[];
  parentRunId?: string | null;
  grantCancel?: boolean;
  timeoutMs?: number;
  /**
   * Appended to the task prompt the agent sees and to the user step.
   * Poisoned content only. Not a second speaker.
   */
  attachedNote?: string;
  /**
   * Set only when the security attacker (or another attacker) is driving this run.
   * Requires an injection plan. Baseline stays unset.
   */
  attackerPayloadId?: string;
  /** Agent-service tool hook. Absent on catalog presets, which keep their own effect. */
  toolHook?: ToolBoundaryHook;
  /** Override the remote agent poster. Tests use this to avoid a live agent process. */
  callAgent?: (baseUrl: string, request: Parameters<typeof runRemoteAgent>[1]) => Promise<AgentRunResponse>;
  probe?: (baseUrl: string) => Promise<boolean>;
  /** Test hook for `controlled_retry` backoff. Production waits. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called after world setup and before the agent acts. The world gate is held.
   * Tests use this as a barrier. It is not read from the HTTP body and not stored on Run or Trace.
   */
  afterWorldSetup?: () => void | Promise<void>;
}

export interface TaskRunResult {
  run: Run;
  trace: Trace | null;
  prepass: PrePassFinding[];
  session_id: string;
  order_id?: string;
  permissions: string[];
  driver: "scripted" | "http";
}

const DEFAULT_TIMEOUT_MS = 30_000;

function isFixKind(value: string): value is FixKind {
  return (FIX_KINDS as readonly string[]).includes(value);
}

function resolvePlan(
  phase: RunPhase,
  taskId: string,
  injection: RunTasksOptions["injection"],
): InjectionPlan | null {
  if (phase === "baseline") {
    if (injection) {
      throw new Error("baseline runs cannot carry an injection plan.");
    }
    return null;
  }
  if (phase === "injected") {
    if (injection && injection !== "preset") return normalizePlan(injection);
    return presetPlan(taskId);
  }
  if (!injection || injection === "preset") {
    return injection === "preset" ? presetPlan(taskId) : null;
  }
  return normalizePlan(injection);
}

function resolveFixKinds(phase: RunPhase, fixKinds: readonly string[] | undefined): FixKind[] {
  const kinds: FixKind[] = [];
  for (const kind of fixKinds ?? []) {
    if (!isFixKind(kind)) throw new Error(`Unknown fix kind ${kind}.`);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  if (phase === "after_fix" && kinds.length === 0) {
    throw new Error("after_fix runs require at least one fix kind.");
  }
  if (phase !== "after_fix" && kinds.length > 0) {
    throw new Error(`${phase} runs cannot carry fix_kinds.`);
  }
  return kinds;
}

function resolveAttackerPayloadId(value: string | undefined, plan: InjectionPlan | null): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("attacker payload id must be a non-empty string.");
  if (!plan) throw new Error("An attacker payload requires an injection plan.");
  return trimmed;
}

function withAttachedNote(prompt: string, note: string | undefined): string {
  if (note === undefined || note.length === 0) return prompt;
  return `${prompt}\n\n${note}`;
}

function agentBaseUrl(agent: Agent, phase: RunPhase): string {
  return phase === "baseline" ? agent.instance.base_url : agent.test_instance.base_url;
}

function sessionIdFor(taskId: string): string {
  return `s${taskId}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * Run each requested task in order.
 * The mock-world gate is held for the whole batch, from before the first reset
 * until the last snapshot, verifier, and result save have finished.
 * A second caller in this process receives `WorldBusyError`. The same call may re-enter.
 */
export async function runTasks(options: RunTasksOptions): Promise<TaskRunResult[]> {
  const taskIds = options.taskIds ?? options.agent.tasks.map((task) => task.task_id);
  for (const taskId of taskIds) taskById(options.agent, taskId);
  // Probe before the gate so a down agent does not occupy the mock.
  const driver = await resolveDriver(options);
  return withWorldGate(async () => {
    const results: TaskRunResult[] = [];
    for (const taskId of taskIds) {
      results.push(await runOne(options, taskId, driver));
    }
    return results;
  });
}

async function resolveDriver(options: RunTasksOptions): Promise<"scripted" | "http"> {
  const requested = options.driver ?? "scripted";
  if (requested !== "auto") return requested;
  const probe = options.probe ?? probeAgent;
  const up = await probe(agentBaseUrl(options.agent, options.phase));
  return up ? "http" : "scripted";
}

async function runOne(
  options: RunTasksOptions,
  taskId: string,
  driver: "scripted" | "http",
): Promise<TaskRunResult> {
  const task = taskById(options.agent, taskId);
  const plan = resolvePlan(options.phase, taskId, options.injection);
  const fixKinds = resolveFixKinds(options.phase, options.fixKinds);
  const attackerPayloadId = resolveAttackerPayloadId(options.attackerPayloadId, plan);
  const permissions = permissionsFor(task, options.grantCancel ?? true);
  const sessionId = sessionIdFor(taskId);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runId = `run-${taskId}-${options.phase}-${randomUUID()}`;
  const traceId = `trace-${taskId}-${options.phase}-${randomUUID()}`;
  const startedMs = Date.now();

  const running: Run = {
    run_id: runId,
    agent_id: options.agent.agent_id,
    task_id: taskId,
    parent_run_id: options.parentRunId ?? null,
    phase: options.phase,
    status: "running",
    trace_ids: [],
    injection_plan: plan,
    fix_kinds: fixKinds,
  };
  await options.store.saveRun(running);

  try {
    const prepared = await prepareWorld(task, options.mock, sessionId);
    await options.afterWorldSetup?.();
    const prompt = withAttachedNote(task.prompt, options.attachedNote);
    const remote = await loadActions(
      options,
      driver,
      running,
      prompt,
      task,
      sessionId,
      permissions,
      prepared.orderId,
    );
    const execution = await executeAttempt({
      prompt,
      taskId,
      actions: remote.actions,
      client: options.mock,
      sessionId,
      permissions,
      plan,
      timeoutMs,
      startedMs,
      claimedSuccess: remote.claimedSuccess,
      toolHook: options.toolHook,
      fixKinds: running.fix_kinds,
      sleep: options.sleep,
    });
    const shopState = await options.mock.state();
    const outcome = verifyOutcome({
      checks: task.success_test.checks,
      snapshot: shopState.parsed,
      wireSnapshot: shopState.raw,
      sessionId,
      permissions,
      orderId: prepared.orderId,
      reportedOrderStatus: execution.reportedOrderStatus,
      agentClaimedSuccess: execution.claimedSuccess,
    });
    const bounds = traceBounds(startedMs, execution.steps.length);
    const findings = prePass({
      started_at: bounds.started_at,
      ended_at: bounds.ended_at,
      steps: execution.steps,
      timeoutMs,
    });
    if (execution.timedOut && !findings.some((finding) => finding.kind === "timeout")) {
      findings.unshift({
        kind: "timeout",
        detail: `Stopped after the ${timeoutMs} ms harness limit.`,
      });
    }

    const status: TraceStatus = execution.timedOut
      ? "timeout"
      : findings.some((finding) => finding.kind === "timeout")
        ? "timeout"
        : outcome.verifier.passed
          ? "completed"
          : "failed";

    const finishedPlan = plan
      ? {
          ...plan,
          ground_truth: {
            ...plan.ground_truth,
            step_id: execution.labels[0]?.step_id ?? plan.ground_truth.step_id,
          },
        }
      : null;

    const trace: Trace = {
      trace_id: traceId,
      agent_id: options.agent.agent_id,
      run_id: runId,
      task_id: taskId,
      started_at: bounds.started_at,
      ended_at: bounds.ended_at,
      status,
      steps: execution.steps,
      outcome,
      totals: {
        latency_ms: execution.steps.reduce((sum, step) => sum + step.latency_ms, 0),
        tokens_in: execution.steps.reduce((sum, step) => sum + step.token_usage.input, 0),
        tokens_out: execution.steps.reduce((sum, step) => sum + step.token_usage.output, 0),
        cost_usd: execution.steps.reduce((sum, step) => sum + step.cost_usd, 0),
      },
      fault: {
        injected: finishedPlan !== null,
        labels: finishedPlan ? execution.labels : [],
        attacker: attackerPayloadId
          ? { used: true, payload_id: attackerPayloadId }
          : { used: false, payload_id: null },
      },
      diagnosis: null,
    };

    const savedTrace = await options.store.saveTrace(trace);
    const savedRun = await options.store.saveRun({
      ...running,
      status: status === "completed" ? "passed" : "failed",
      trace_ids: [savedTrace.trace_id],
      injection_plan: finishedPlan,
      duration_ms: Math.max(0, Date.now() - startedMs),
      ...(status === "timeout" ? { error_message: "Harness stopped on the time limit." } : {}),
    });

    return {
      run: savedRun,
      trace: savedTrace,
      prepass: findings,
      session_id: sessionId,
      order_id: prepared.orderId,
      permissions,
      driver,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Harness error";
    await options.store.saveRun({
      ...running,
      status: "error",
      trace_ids: [],
      duration_ms: Math.max(0, Date.now() - startedMs),
      error_message: message,
    });
    if (error instanceof ContractError) throw error;
    return {
      run: (await options.store.getRun(runId)) ?? running,
      trace: null,
      prepass: [],
      session_id: sessionId,
      permissions,
      driver,
    };
  }
}

async function loadActions(
  options: RunTasksOptions,
  driver: "scripted" | "http",
  run: Run,
  prompt: string,
  task: Agent["tasks"][number],
  sessionId: string,
  permissions: string[],
  orderId: string | undefined,
): Promise<{ actions: PlannedAction[]; claimedSuccess?: boolean }> {
  if (driver === "scripted") {
    return { actions: scriptedActions(task, { permissions, orderId }) };
  }
  const call = options.callAgent ?? runRemoteAgent;
  const request = agentRunRequest({
    agent_id: options.agent.agent_id,
    task_id: task.task_id,
    task,
    prompt,
    session_id: sessionId,
    permissions,
    mock_base_url: options.mockBaseUrl,
    order_id: orderId,
    fix_kinds: run.fix_kinds,
  });
  const response = await call(agentBaseUrl(options.agent, options.phase), request);
  if (response.executed) {
    throw new Error(
      "This harness MVP mediates tool calls. The agent response must set executed to false and return actions.",
    );
  }
  return { actions: response.actions ?? [], claimedSuccess: response.claimed_success };
}
