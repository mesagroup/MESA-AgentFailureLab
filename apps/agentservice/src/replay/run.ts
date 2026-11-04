import { FIX_KINDS, type FaultCategory, type FixKind } from "@mesa/shared";
import { LAB_TASK_IDS, type LabTaskId } from "../fixes/domain.js";
import { runApplicatorProbes } from "../fixes/probes.js";
import { GUARD_GAP, HARNESS_GAP, OWNER_REQUESTS, RETRY_GAP } from "./requests.js";
import { selectFixes } from "./select.js";
import { verifyFix } from "./verification.js";
import type { AttemptScore, ReplayPort, ReplayReport, ScoredArm, TaskReplayRow } from "./types.js";

export async function runReplay(input: {
  port: ReplayPort;
  categoryFor: (taskId: LabTaskId) => FaultCategory;
  tasks?: readonly LabTaskId[];
  specified?: Partial<Record<LabTaskId, readonly FixKind[]>>;
  diagnosisFixes?: Partial<Record<LabTaskId, readonly FixKind[]>>;
}): Promise<ReplayReport> {
  const tasks = input.tasks ?? LAB_TASK_IDS;
  const rows: TaskReplayRow[] = [];
  for (const taskId of tasks) {
    rows.push(await runTask(input, taskId));
  }
  const attempts = rows.flatMap(attemptsOf);
  const latencyMatches = attempts.every((attempt) => attempt.latency_ms === attempt.step_count);
  const tokensAreZero = attempts.every(
    (attempt) => attempt.tokens_in === 0 && attempt.tokens_out === 0 && attempt.cost_usd === 0,
  );
  const verified = rows.filter((row) => row.fix_verified === true).map((row) => row.task_id);
  return {
    schema_version: 1,
    label:
      "Harness verifier scores for T1–T5. The agent service does not write outcome.verifier or fault.*.",
    decision:
      "fix_verified requires a passing clean baseline, a failing injected_before, a passing injected_after and a completed non-regressing clean control. Skipped evidence is inconclusive.",
    runs_per_arm: 1,
    spread: "not applicable: verifier.passed is a deterministic function of the shop seed and the preset.",
    timing: {
      latency_ms_equals_step_count: latencyMatches,
      limiter: latencyMatches
        ? "Observed latency_ms equals step_count on every arm. The harness writes latency_ms: 1 on each step, so this number counts steps. It cannot be twice as good while that writer stays."
        : "latency_ms did not equal step_count. The step-counter explanation does not hold for this run.",
      tokens_and_cost: tokensAreZero
        ? "tokens_in, tokens_out, and cost_usd are 0 on every arm. The scripted driver does not call a model. These are the harness totals, not an estimate."
        : "A non-zero token or cost total appeared. That is not the scripted driver this report describes.",
      duration_ms:
        "duration_ms is wall clock around one harness run, including loopback shop HTTP. It is not the decision. One sample has no spread to compare.",
    },
    tasks: rows,
    probes: await runApplicatorProbes(),
    blocked: [
      HARNESS_GAP,
      RETRY_GAP,
      GUARD_GAP,
      `Preset verifier flips in this run: ${verified.length === 0 ? "none" : verified.join(", ")}.`,
    ],
    requests: OWNER_REQUESTS,
  };
}

async function runTask(
  input: {
    port: ReplayPort;
    categoryFor: (taskId: LabTaskId) => FaultCategory;
    specified?: Partial<Record<LabTaskId, readonly FixKind[]>>;
    diagnosisFixes?: Partial<Record<LabTaskId, readonly FixKind[]>>;
  },
  taskId: LabTaskId,
): Promise<TaskReplayRow> {
  const category = input.categoryFor(taskId);
  const selected = selectFixes({
    specified: input.specified?.[taskId],
    diagnosisFixes: input.diagnosisFixes?.[taskId],
    category,
  });
  const baseline = await input.port.run({ taskId, phase: "baseline", fixes: [] });
  const baselineAll = await input.port.run({
    taskId,
    phase: "baseline",
    fixes: [...FIX_KINDS],
  });
  const before = await input.port.run({ taskId, phase: "injected", fixes: [] });
  const after = await runAfter(input.port, taskId, selected.kinds, before.run_id);
  // Legacy replay uses its existing all-fixes control. The HTTP demo command
  // uses a complete control suite with exactly the selected treatment instead.
  const verdict = verifyFix({ baseline: baseline.passed, before: before.passed,
    after: after.status === "ran" ? after.attempt.passed : null,
    expectedControls: [taskId], controls: [{ taskId, baseline: baseline.passed, treated: baselineAll.passed }] });
  return {
    task_id: taskId,
    preset_category: category,
    fix_kinds: selected.kinds,
    fix_source: selected.source,
    baseline,
    baseline_all_fixes: baselineAll,
    injected_before: before,
    injected_after: after,
    fix_verified: verdict.fix_verified,
    regression: baseline.passed && !baselineAll.passed,
  };
}

async function runAfter(
  port: ReplayPort,
  taskId: LabTaskId,
  fixes: readonly FixKind[],
  parentRunId: string,
): Promise<ScoredArm> {
  if (fixes.length === 0) {
    return {
      status: "skipped",
      reason: "No MVP fix for this preset category. after_fix requires at least one FixKind, so this arm was not run.",
    };
  }
  const attempt = await port.run({ taskId, phase: "after_fix", fixes, parentRunId });
  return { status: "ran", attempt };
}

function attemptsOf(row: TaskReplayRow): AttemptScore[] {
  const attempts = [row.baseline, row.baseline_all_fixes, row.injected_before];
  if (row.injected_after.status === "ran") attempts.push(row.injected_after.attempt);
  return attempts;
}

export function renderReplayMarkdown(report: ReplayReport): string {
  const lines: string[] = [
    "# Fix replay",
    "",
    report.label,
    "",
    `Decision: ${report.decision}`,
    "",
    `Runs per arm: ${report.runs_per_arm}. ${report.spread}`,
    "",
    "## Verifier",
    "",
    "| Task | Preset | Fix | Source | Baseline | Baseline + all fixes | Injected | After | Fix verified | Regression |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.tasks) {
    lines.push(
      `| ${row.task_id} | ${row.preset_category} | ${formatFixes(row.fix_kinds)} | ${row.fix_source} | ${passFail(row.baseline.passed)} | ${passFail(row.baseline_all_fixes.passed)} | ${passFail(row.injected_before.passed)} | ${afterCell(row.injected_after)} | ${verifiedCell(row.fix_verified)} | ${row.regression ? "yes" : "no"} |`,
    );
  }
  lines.push(
    "",
    "## What the timings are",
    "",
    report.timing.limiter,
    "",
    report.timing.tokens_and_cost,
    "",
    report.timing.duration_ms,
    "",
    "## Applicator probes",
    "",
    report.probes.label,
    "",
    `- Read retry attempts: ${report.probes.read_retry.attempts} (${report.probes.read_retry.outcome}), slept_ms ${report.probes.read_retry.slept_ms.join(", ") || "none"}.`,
    `- Checkout dispatched 5xx attempts: ${report.probes.mutate_dispatched_5xx_attempts}.`,
    `- Checkout not-dispatched attempts: ${report.probes.mutate_not_dispatched_attempts}.`,
    `- cancel_order refused without write:order:cancel: ${report.probes.cancel_refused}, client calls ${report.probes.cancel_client_calls_when_refused}.`,
    `- Note-driven cancel calls without the guard: ${report.probes.note_cancel_calls_without_guard}, permissions ${report.probes.note_permissions_without_guard.join(", ") || "none"}.`,
    `- Note-driven cancel calls with the guard: ${report.probes.note_cancel_calls_with_guard}.`,
    `- Forged checkout claimed success: ${report.probes.forged_checkout_claimed_success}.`,
    "",
    "## Blocked",
    "",
  );
  for (const note of report.blocked) {
    lines.push(`- ${note}`);
  }
  lines.push("", "## Requests", "");
  for (const request of report.requests) {
    lines.push(`- ${request.owner} — ${request.area}: ${request.request}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatFixes(fixes: readonly FixKind[]): string {
  return fixes.length === 0 ? "none" : fixes.join(", ");
}

function passFail(passed: boolean): string {
  return passed ? "pass" : "fail";
}

function afterCell(arm: ScoredArm): string {
  return arm.status === "ran" ? passFail(arm.attempt.passed) : "skipped";
}

function verifiedCell(value: boolean | null): string {
  if (value === null) return "n/a";
  return value ? "yes" : "no";
}
