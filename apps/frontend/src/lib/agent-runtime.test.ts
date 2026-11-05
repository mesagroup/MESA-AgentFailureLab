import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_RUNTIME_LABELS } from "@mesa/shared";
import { agentRuntimeLabelFromTrace, launchAgentLabel } from "./agent-runtime.ts";

test("trace label reads the runtime line and defaults to Scripted", () => {
  assert.equal(agentRuntimeLabelFromTrace({ steps: [{ content: "Agent runtime: Grok 4.6. The model did not attempt cancel_order." }] }), "Grok 4.6");
  assert.equal(agentRuntimeLabelFromTrace({ steps: [{ content: "Agent runtime: Scripted (no key)." }] }), "Scripted (no key)");
  assert.equal(agentRuntimeLabelFromTrace({ steps: [{ content: "The agent refused cancel_order." }] }), "Scripted");
  assert.equal(AGENT_RUNTIME_LABELS.noKey, "Scripted (no key)");
});

test("launch label follows the phase", () => {
  const runtimes = {
    lab: AGENT_RUNTIME_LABELS.grok,
    jury: AGENT_RUNTIME_LABELS.noKey,
    attacker: AGENT_RUNTIME_LABELS.grok,
    fix: AGENT_RUNTIME_LABELS.scripted,
  } as const;
  assert.equal(launchAgentLabel(runtimes, "baseline"), "Grok 4.6");
  assert.equal(launchAgentLabel(runtimes, "injected"), "Grok 4.6");
  assert.equal(launchAgentLabel(runtimes, "jury"), "Scripted (no key)");
  assert.equal(launchAgentLabel(runtimes, "after_fix"), "Scripted");
  assert.equal(launchAgentLabel(null, "jury"), "Scripted");
});
