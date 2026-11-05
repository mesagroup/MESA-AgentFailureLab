import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, Run } from "@mesa/shared";
import {
  baselineRunsForAgent,
  buildLaunchParams,
  filterRunsByQuery,
  phaseNeedsBaselineParent,
  taskTitleForRun,
  toggleLaunchFixKind,
} from "./run-launch.ts";

function run(partial: Partial<Run> & Pick<Run, "run_id" | "agent_id" | "task_id" | "phase" | "status">): Run {
  return {
    trace_ids: [],
    injection_plan: null,
    fix_kinds: [],
    ...partial,
  };
}

test("baselineRunsForAgent keeps terminal baselines for the agent", () => {
  const rows = [
    run({ run_id: "run-b", agent_id: "a1", task_id: "T1", phase: "baseline", status: "passed" }),
    run({ run_id: "run-a", agent_id: "a1", task_id: "T2", phase: "baseline", status: "failed" }),
    run({ run_id: "run-q", agent_id: "a1", task_id: "T3", phase: "baseline", status: "queued" }),
    run({ run_id: "run-i", agent_id: "a1", task_id: "T1", phase: "injected", status: "passed" }),
    run({ run_id: "run-x", agent_id: "other", task_id: "T1", phase: "baseline", status: "passed" }),
  ];
  assert.deepEqual(
    baselineRunsForAgent(rows, "a1").map((item) => item.run_id),
    ["run-b", "run-a"],
  );
  const newestFirst = [
    run({ run_id: "run-old", agent_id: "a1", task_id: "T1", phase: "baseline", status: "passed" }),
    run({ run_id: "run-new", agent_id: "a1", task_id: "T2", phase: "baseline", status: "passed" }),
  ];
  assert.deepEqual(
    baselineRunsForAgent(newestFirst, "a1").map((item) => item.run_id),
    ["run-old", "run-new"],
  );
});

test("phaseNeedsBaselineParent is true for injected and after_fix", () => {
  assert.equal(phaseNeedsBaselineParent("baseline"), false);
  assert.equal(phaseNeedsBaselineParent("injected"), true);
  assert.equal(phaseNeedsBaselineParent("after_fix"), true);
});

test("buildLaunchParams validates each phase", () => {
  assert.equal(buildLaunchParams({
    agentId: "a1",
    phase: "baseline",
    taskIds: [],
    parentRunId: null,
    fixKinds: [],
  }).ok, false);

  const baseline = buildLaunchParams({
    agentId: "a1",
    phase: "baseline",
    taskIds: ["T1"],
    parentRunId: null,
    fixKinds: [],
  });
  assert.equal(baseline.ok, true);
  if (baseline.ok) {
    assert.deepEqual(baseline.params, {
      agent_id: "a1",
      phase: "baseline",
      task_ids: ["T1"],
    });
  }

  assert.equal(buildLaunchParams({
    agentId: "a1",
    phase: "injected",
    taskIds: [],
    parentRunId: null,
    fixKinds: [],
  }).ok, false);

  const injected = buildLaunchParams({
    agentId: "a1",
    phase: "injected",
    taskIds: [],
    parentRunId: "run-base",
    fixKinds: [],
  });
  assert.equal(injected.ok, true);
  if (injected.ok) {
    assert.deepEqual(injected.params, {
      agent_id: "a1",
      phase: "injected",
      parent_run_id: "run-base",
    });
  }

  assert.equal(buildLaunchParams({
    agentId: "a1",
    phase: "after_fix",
    taskIds: [],
    parentRunId: "run-base",
    fixKinds: [],
  }).ok, false);

  const afterFix = buildLaunchParams({
    agentId: "a1",
    phase: "after_fix",
    taskIds: [],
    parentRunId: "run-base",
    fixKinds: ["pre_response_check"],
  });
  assert.equal(afterFix.ok, true);
  if (afterFix.ok) {
    assert.deepEqual(afterFix.params, {
      agent_id: "a1",
      phase: "after_fix",
      parent_run_id: "run-base",
      fix_kinds: ["pre_response_check"],
    });
  }
});

test("toggleLaunchFixKind adds and removes", () => {
  assert.deepEqual(toggleLaunchFixKind([], "permission_guard"), ["permission_guard"]);
  assert.deepEqual(toggleLaunchFixKind(["permission_guard"], "permission_guard"), []);
});

test("buildLaunchParams includes prompt_override when edited", () => {
  const injected = buildLaunchParams({
    agentId: "a1",
    phase: "injected",
    taskIds: [],
    parentRunId: "run-base",
    fixKinds: [],
    promptOverride: "Hold BK-RARE for patron-ada and confirm.",
  });
  assert.equal(injected.ok, true);
  if (injected.ok) {
    assert.equal(injected.params.prompt_override, "Hold BK-RARE for patron-ada and confirm.");
  }
});

test("taskTitleForRun and filterRunsByQuery use agent task metadata", () => {
  const agent = {
    agent_id: "external-library",
    tasks: [{ task_id: "place-hold", title: "Hold the atlas for Ada", prompt: "Place a hold for patron-ada." }],
  } as Agent;
  const rows = [
    run({ run_id: "run-hold", agent_id: "external-library", task_id: "place-hold", phase: "baseline", status: "passed" }),
    run({ run_id: "run-other", agent_id: "external-library", task_id: "renew-loan", phase: "baseline", status: "passed" }),
  ];
  assert.equal(taskTitleForRun(agent, rows[0]!), "Hold the atlas for Ada");
  assert.deepEqual(
    filterRunsByQuery(rows, agent, "atlas").map((item) => item.run_id),
    ["run-hold"],
  );
  assert.deepEqual(
    filterRunsByQuery(rows, agent, "renew").map((item) => item.run_id),
    ["run-other"],
  );
});
