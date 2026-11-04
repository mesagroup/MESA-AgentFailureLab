import assert from "node:assert/strict";
import test from "node:test";
import { canDeleteAgent, canEditAgent } from "./agents-page.ts";

test("demo seeds are edited like any other agent and are not deleted", () => {
  for (const agentId of ["reference-shop", "gift-desk"]) {
    assert.equal(canEditAgent(agentId), true);
    assert.equal(canDeleteAgent(agentId), false);
  }
  assert.equal(canEditAgent("agent-ext-001"), true);
  assert.equal(canDeleteAgent("agent-ext-001"), true);
});
