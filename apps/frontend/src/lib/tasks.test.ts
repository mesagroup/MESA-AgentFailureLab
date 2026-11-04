import assert from "node:assert/strict";
import test from "node:test";
import { TASK_EVALSET_VERSION, type AgentTask, type TaskEvalset } from "@mesa/shared";
import {
  appendEvalCase,
  blankTask,
  removeEvalCase,
  taskFieldErrors,
  tasksHaveErrors,
  writeEvalCase,
} from "./tasks.ts";

test("a new task is not prefilled with shop values", () => {
  const task = blankTask("task-1");
  assert.equal(task.title, "");
  assert.equal(task.prompt, "");
  assert.equal(task.evalset, undefined);
  assert.deepEqual(task.setup.permissions, []);
  assert.deepEqual(task.setup.cart, []);
  const encoded = JSON.stringify(task);
  assert.equal(encoded.includes("SKU-MUG-01"), false);
  assert.equal(encoded.includes("Search and open"), false);
});

test("empty tasks report a field error instead of one combined string", () => {
  const errors = taskFieldErrors([blankTask("task-1")]);
  assert.equal(tasksHaveErrors(errors), true);
  assert.equal(errors[0]?.title, "Enter a title.");
  assert.equal(errors[0]?.prompt, "Enter the prompt the agent will see.");
  assert.equal(errors[0]?.evalset, undefined);
});

test("version 1 with no cases is valid and a missing evalset is valid", () => {
  const omitted = filled("task-1");
  const empty = filled("task-2");
  empty.evalset = { version: TASK_EVALSET_VERSION, cases: [] };
  const errors = taskFieldErrors([omitted, empty]);
  assert.equal(tasksHaveErrors(errors), false);
  assert.equal(errors[0]?.evalset, undefined);
  assert.equal(errors[1]?.evalset, undefined);
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
  const errors = taskFieldErrors([task]);
  assert.equal(tasksHaveErrors(errors), true);
  assert.equal(errors[0]?.eval_cases[0]?.case_id, undefined);
  assert.equal(errors[0]?.eval_cases[1]?.case_id, "This case id is already used.");
  assert.equal(errors[0]?.eval_cases[1]?.expectation, "Enter what Grok should look for.");
  assert.equal(errors[0]?.eval_cases[2]?.case_id, "Enter a case id.");
  assert.equal(errors[0]?.eval_cases[2]?.rubric, "Enter how to score the expectation, or leave the rubric off.");
});

test("an evalset version other than 1 is rejected and cases stay required", () => {
  const wrong = filled("task-1");
  wrong.evalset = { version: 2, cases: [] } as unknown as TaskEvalset;
  const missing = filled("task-2");
  missing.evalset = { version: TASK_EVALSET_VERSION } as unknown as TaskEvalset;
  const errors = taskFieldErrors([wrong, missing]);
  assert.equal(errors[0]?.evalset, "Evalset version must be 1.");
  assert.equal(errors[1]?.evalset, "Evalset cases are required.");
  assert.equal(tasksHaveErrors(errors), true);
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
  const task = blankTask(taskId);
  task.title = "Open the mug";
  task.prompt = "Find the ceramic mug and open it.";
  task.success_test.checks[0]!.description = "The session searched the catalog.";
  return task;
}
