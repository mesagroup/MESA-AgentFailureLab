import type { Agent, AgentRunRequest, FaultCategory, FixKind } from "@mesa/shared";
import { permissionsFor } from "../../backend/src/agent/scripted.js";
import { prepareWorld } from "../../backend/src/harness/world.js";
import { withWorldGate } from "../../backend/src/harness/world-gate.js";
import { runTasks } from "../../backend/src/harness/runner.js";
import { presetPlan } from "../../backend/src/injector/catalog.js";
import type { MockShopClient } from "../../backend/src/mock/client.js";
import type { RunStore } from "../../backend/src/persistence/memory.js";
import { taskById } from "../../backend/src/reference-agent.js";
import { verifyOutcome } from "../../backend/src/verifier/verify.js";
import { createHttpShopToolClient } from "../src/fixes/applicator.js";
import { LAB_TASK_IDS, type LabTaskId } from "../src/fixes/domain.js";
import { applyFixesToPlan, assertLabTaskId } from "../src/fixes/plan.js";
import { ALL_FIXES, runScriptedAgent } from "../src/fixes/scripted-agent.js";
import type { AttemptScore, ReplayPort } from "../src/replay/types.js";

/**
 * Replay port over the merged harness (`runTasks`).
 * Injected and after_fix arms use `injection: "preset"`, so the backend injector
 * is the only writer of fault labels. `passed` is copied from the trace the
 * verifier already wrote.
 * When fixes are non-empty, the policy runs inside the `callAgent` hook.
 * `after_fix` copies `Run.fix_kinds` onto the shared `AgentRunRequest`. This hook
 * reads that field when it is present, and falls back to the replay's fix list
 * for the baseline arm that applies every fix without storing them on the Run.
 */
export function createHarnessReplayPort(input: {
  agent: Agent;
  store: RunStore;
  mock: MockShopClient;
  mockBaseUrl: string;
}): ReplayPort {
  return {
    async run(request) {
      const apply = request.fixes.length > 0;
      let carriedOnRequest = false;
      const [result] = await runTasks({
        agent: input.agent,
        store: input.store,
        mock: input.mock,
        mockBaseUrl: input.mockBaseUrl,
        phase: request.phase,
        taskIds: [request.taskId],
        driver: apply ? "http" : "scripted",
        injection: request.phase === "baseline" ? undefined : "preset",
        fixKinds: request.phase === "after_fix" ? [...request.fixes] : undefined,
        parentRunId: request.parentRunId ?? null,
        grantCancel: true,
        timeoutMs: 5_000,
        callAgent: apply
          ? (_baseUrl, body) => {
              carriedOnRequest = body.fix_kinds !== undefined && body.fix_kinds.length > 0;
              const taskId = assertLabTaskId(body.task_id);
              const shaped = applyFixesToPlan({
                taskId,
                permissions: body.permissions,
                orderId: body.order_id,
                fixes: fixesFromRequest(body, request.fixes),
                prompt: body.prompt,
              });
              return Promise.resolve({
                executed: false,
                actions: shaped.actions.map((action) => ({
                  tool_name: action.tool_name,
                  tool_input: { ...action.tool_input },
                })),
              });
            }
          : undefined,
      });
      if (result === undefined || result.trace === null) {
        const message = result?.run.error_message ?? "no trace";
        throw new Error(`${request.taskId} ${request.phase} produced no trace (${message}).`);
      }
      const trace = result.trace;
      const score: AttemptScore = {
        source: "backend-harness",
        run_id: result.run.run_id,
        parent_run_id: result.run.parent_run_id ?? null,
        passed: trace.outcome.verifier.passed,
        failed_checks: trace.outcome.verifier.checks
          .filter((check) => !check.passed)
          .map((check) => check.name),
        agent_claimed_success: trace.outcome.agent_claimed_success,
        latency_ms: trace.totals.latency_ms,
        step_count: trace.steps.length,
        tokens_in: trace.totals.tokens_in,
        tokens_out: trace.totals.tokens_out,
        cost_usd: trace.totals.cost_usd,
        duration_ms: result.run.duration_ms ?? 0,
        fix_kinds_on_run: result.run.fix_kinds,
        policy_applied_in_call_agent: apply,
        fix_kinds_on_agent_run_request: carriedOnRequest,
      };
      return score;
    },
  };
}

function fixesFromRequest(body: AgentRunRequest, fallback: readonly FixKind[]): readonly FixKind[] {
  return body.fix_kinds ?? fallback;
}

export function presetCategory(taskId: LabTaskId): FaultCategory {
  return presetPlan(taskId).ground_truth.category;
}

export interface ScriptedBaselineRow {
  readonly label: "scripted-applicator against the shop. No fault injection. Scored by verifyOutcome.";
  readonly task_id: LabTaskId;
  readonly passed: boolean;
  readonly claimed_success: boolean;
  readonly failed_checks: readonly string[];
}

/**
 * The labelled scripted agent calls the shop itself, so nothing is injected.
 * `verifyOutcome` is the scorer. This function does not assign `outcome.verifier`.
 * The in-process world gate is held for the whole loop, so one task's reset cannot
 * land inside another's setup-to-snapshot sequence in this process.
 */
export async function scoreScriptedBaseline(input: {
  baseUrl: string;
  mock: MockShopClient;
  agent: Agent;
}): Promise<ScriptedBaselineRow[]> {
  return withWorldGate(() => scoreScriptedBaselineHeld(input));
}

async function scoreScriptedBaselineHeld(input: {
  baseUrl: string;
  mock: MockShopClient;
  agent: Agent;
}): Promise<ScriptedBaselineRow[]> {
  const client = createHttpShopToolClient(input.baseUrl);
  const rows: ScriptedBaselineRow[] = [];
  for (const taskId of LAB_TASK_IDS) {
    const task = taskById(input.agent, taskId);
    const permissions = permissionsFor(task, true);
    const sessionId = `s${taskId}fixbase`;
    const prepared = await prepareWorld(task, input.mock, sessionId);
    const result = await runScriptedAgent({
      taskId,
      prompt: task.prompt,
      sessionId,
      permissions,
      orderId: prepared.orderId,
      fixes: ALL_FIXES,
      client,
      now: () => 0,
      sleep: async () => {},
    });
    const state = await input.mock.state();
    const outcome = verifyOutcome({
      checks: task.success_test.checks,
      snapshot: state.parsed,
      wireSnapshot: state.raw,
      sessionId,
      permissions,
      orderId: prepared.orderId,
      reportedOrderStatus: result.reported_order_status,
      agentClaimedSuccess: result.claimed_success,
    });
    rows.push({
      label: "scripted-applicator against the shop. No fault injection. Scored by verifyOutcome.",
      task_id: taskId,
      passed: outcome.verifier.passed,
      claimed_success: result.claimed_success,
      failed_checks: outcome.verifier.checks.filter((check) => !check.passed).map((check) => check.name),
    });
  }
  return rows;
}
