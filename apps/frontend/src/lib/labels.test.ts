import assert from "node:assert/strict";
import test from "node:test";
import { faultCodeLabel, formatCost, formatRunLabel, formatTaskLabel, formatTraceTitle, permissionLabel } from "./labels.ts";

test("runs are labeled by time and task title", () => {
  const label = formatRunLabel({ taskTitle: "Check out the cart", at: "2026-11-04T20:51:27.030Z" });
  assert.match(label, /Check out the cart/);
  assert.equal(label.includes("run-"), false);
});

test("a run without a clock uses Run #N and the task title", () => {
  assert.equal(formatRunLabel({ taskTitle: "Check out the cart", sequence: 2 }), "Run #2 · Check out the cart");
});

test("traces are titled by the task, not the trace id", () => {
  const title = formatTraceTitle({ taskTitle: "Check out the cart", at: "2026-11-04T20:51:27.030Z" });
  assert.match(title, /^Check out the cart/);
  assert.equal(title.includes("trace-"), false);
});

test("tasks prefer the title", () => {
  assert.equal(formatTaskLabel({ title: "Check out the cart", task_id: "T3" }), "Check out the cart");
  assert.equal(formatTaskLabel({ title: "  ", task_id: "T3" }), "Untitled task");
});

test("fault codes and permissions have readable labels", () => {
  assert.equal(faultCodeLabel("forged_tool_result"), "Forged tool result");
  assert.equal(permissionLabel("write:order:cancel"), "Cancel orders");
});

test("cost is a readable dollar amount", () => {
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(0.0042), "$0.0042");
  assert.equal(formatCost(1.2), "$1.20");
});
