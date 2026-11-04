import assert from "node:assert/strict";
import test from "node:test";
import { blankTask, taskFieldErrors, tasksHaveErrors } from "./tasks.ts";

test("a new task is not prefilled with shop values", () => {
  const task = blankTask("task-1");
  assert.equal(task.title, "");
  assert.equal(task.prompt, "");
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
});
