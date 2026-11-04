import assert from "node:assert/strict";
import test from "node:test";
import { TASK_EVALSET_VERSION, type AgentTask, type TaskEvalset } from "@mesa/shared";
import {
  appendEvalCase,
  evalsetErrorMessage,
  evalsetIssues,
  removeEvalCase,
  writeEvalCase,
} from "./tasks.ts";

test("version 1 with no cases is valid and a missing evalset is valid", () => {
  const omitted = filled("task-1");
  const empty = filled("task-2");
  empty.evalset = { version: TASK_EVALSET_VERSION, cases: [] };
  assert.equal(evalsetIssues(omitted).evalset, undefined);
  assert.deepEqual(evalsetIssues(omitted).cases, {});
  assert.equal(evalsetIssues(empty).evalset, undefined);
  assert.equal(evalsetErrorMessage(omitted), undefined);
  assert.equal(evalsetErrorMessage(empty), undefined);
});

test("evalset cases require a unique id and an expectation", () => {
  const task = filled("task-1");
  task.evalset = {
    version: TASK_EVALSET_VERSION,
    cases: [
      { case_id: "claim", expectation: "The assistant cites the catalog read." },
      { case_id: "claim", expectation: " " },
      { case_id: " ", expectation: "Something to look for.", rubric: " " },
    ],
  };
  const issues = evalsetIssues(task);
  assert.equal(issues.cases[0]?.case_id, undefined);
  assert.equal(issues.cases[1]?.case_id, "This case id is already used.");
  assert.equal(issues.cases[1]?.expectation, "Enter what Grok should look for.");
  assert.equal(issues.cases[2]?.case_id, "Enter a case id.");
  assert.equal(issues.cases[2]?.rubric, "Enter how to score the expectation, or leave the rubric off.");
  assert.match(evalsetErrorMessage(task) ?? "", /already used/);
});

test("an evalset version other than 1 is rejected and cases stay required", () => {
  const wrong = filled("task-1");
  wrong.evalset = { version: 2, cases: [] } as unknown as TaskEvalset;
  const missing = filled("task-2");
  missing.evalset = { version: TASK_EVALSET_VERSION } as unknown as TaskEvalset;
  assert.equal(evalsetIssues(wrong).evalset, "Evalset version must be 1.");
  assert.equal(evalsetIssues(missing).evalset, "Evalset cases are required.");
  assert.equal(evalsetErrorMessage(wrong), "Evalset version must be 1.");
});

test("adding a case pins version 1 and removing the last case omits evalset", () => {
  const task = filled("task-1");
  appendEvalCase(task);
  appendEvalCase(task);
  assert.equal(task.evalset?.version, TASK_EVALSET_VERSION);
  assert.deepEqual(
    task.evalset?.cases.map((entry) => entry.case_id),
    ["case-1", "case-2"],
  );
  writeEvalCase(task, 0, {
    case_id: "claim-after-catalog",
    expectation: "The assistant cites the catalog read.",
    rubric: "Cite the claim step.",
  });
  writeEvalCase(task, 0, { rubric: "   " });
  assert.equal(task.evalset?.cases[0]?.rubric, undefined);
  assert.equal(JSON.stringify(task.evalset?.cases[0]).includes("rubric"), false);
  removeEvalCase(task, 1);
  assert.equal(task.evalset?.cases.length, 1);
  assert.equal(task.evalset?.version, 1);
  removeEvalCase(task, 0);
  assert.equal(task.evalset, undefined);
  assert.equal(JSON.stringify(task).includes("evalset"), false);
});

function filled(taskId: string): AgentTask {
  return {
    task_id: taskId,
    title: "Open the mug",
    prompt: "Find the ceramic mug and open it.",
    setup: { cart: [], orders: [], permissions: ["read"] },
    success_test: {
      type: "verifier_checks",
      checks: [{ name: "catalog_read", description: "The session searched the catalog." }],
    },
  };
}
