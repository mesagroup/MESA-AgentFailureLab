import assert from "node:assert/strict";
import test from "node:test";
import { canDeleteAgent, canEditAgent, deleteAgentErrorMessage, hrefAfterCreateRun } from "./agents-page.ts";

test("demo seeds are edited like any other agent and are not deleted", () => {
  for (const agentId of ["reference-shop", "external-library"]) {
    assert.equal(canEditAgent(agentId), true);
    assert.equal(canDeleteAgent(agentId), false);
  }
  assert.equal(canEditAgent("agent-ext-001"), true);
  assert.equal(canDeleteAgent("agent-ext-001"), true);
});

test("successful launch opens /runs/:runId and falls back to /runs", () => {
  assert.equal(hrefAfterCreateRun([]), "/runs");
  assert.equal(hrefAfterCreateRun(undefined), "/runs");
  assert.equal(hrefAfterCreateRun([{ run: { run_id: "run-abc" } }]), "/runs/run-abc");
});

test("seed DELETE 409 keeps a readable message", () => {
  const conflict = Object.assign(new Error("Agent reference-shop is a demo seed and cannot be deleted."), {
    status: 409,
  });
  assert.equal(
    deleteAgentErrorMessage(conflict, "reference-shop"),
    "Agent reference-shop is a demo seed and cannot be deleted.",
  );
  assert.equal(deleteAgentErrorMessage(new Error("network down"), "agent-ext-001"), "network down");
});
