import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import type { Trace } from "@mesa/shared";
import { FAULT_CATEGORIES, FIX_KINDS } from "@mesa/shared";
import { validateTrace } from "@mesa/shared/validate";
import { DiagnosisFailed, diagnoseTrace } from "../src/diagnosis/diagnose.js";
import type { DiagnosisModel, ModelCompletionRequest, ModelUsage } from "../src/diagnosis/diagnose.js";
import { parseDiagnosisConfig } from "../src/grok/config.js";

before(() => {
  globalThis.fetch = () => Promise.reject(new Error("network disabled"));
});

const config = parseDiagnosisConfig({
  XAI_API_KEY: "",
  XAI_BASE_URL: "https://api.x.ai/v1",
  GROK_MODEL: "grok-test",
});

const BANNED_KEYS = new Set([
  "fault",
  "injected",
  "labels",
  "attacker",
  "payload_id",
  "verifier",
  "checks",
  "mock_state_snapshot",
  "success",
  "diagnosis",
]);

describe("diagnoseTrace", () => {
  it("fills diagnosis from the model and keeps the verifier and fault", async () => {
    const input = pending("injected-failed-trace.json");
    const seen: ModelCompletionRequest[] = [];
    const recorded: ModelUsage[] = [];
    const model = scripted(seen, {
      category: "Verification",
      cause: "The agent claimed success from the checkout tool result.",
      step_id: "step-5",
      confidence: 0.8,
      evidence: ["step-5 claims the order was placed."],
      proposed_fixes: ["pre_response_check"],
    }, { input_tokens: 11, output_tokens: 7, cost_usd: 0.002 });

    const output = await diagnoseTrace(input, {
      model,
      modelName: config.modelName,
      onUsage(usage) {
        recorded.push(usage);
      },
    });

    assert.equal(output.diagnosis.step_id, "step-5");
    assert.equal(output.diagnosis.category, "Verification");
    assert.equal(output.diagnosis.confidence, 0.8);
    assert.deepEqual(output.diagnosis.proposed_fixes, ["pre_response_check"]);
    assert.ok(output.diagnosis.evidence.includes("step-5 claims the order was placed."));
    const view = readView(seen[0]!);
    const finding = view.findings.find((item) => item.kind === "false_success_claim");
    assert.ok(finding);
    assert.deepEqual(finding.step_ids, ["step-5"]);
    assert.ok(output.diagnosis.evidence.includes(finding.detail));
    assert.equal(output.outcome, input.outcome);
    assert.equal(output.fault, input.fault);
    assert.equal(output.steps, input.steps);
    assert.equal(input.diagnosis, null);
    assert.equal(output.fault.labels[0]?.code, "forged_tool_result");
    assert.equal(recorded[0]?.input_tokens, 11);
    assert.equal(recorded[0]?.cost_usd, 0.002);
    assert.equal(Object.hasOwn(output, "usage"), false);
    assert.equal(seen[0]?.model, "grok-test");
    for (const category of FAULT_CATEGORIES) {
      assert.equal(seen[0]?.system.includes(category), true);
    }
    for (const fix of FIX_KINDS) {
      assert.equal(seen[0]?.system.includes(fix), true);
    }
    assert.equal(seen[0]?.system.includes("culprit_step_id"), false);
    assert.equal(seen[0]?.system.includes("suggested_fix_ids"), false);
  });

  it("hides fault labels, the attacker, and verifier details from the model", async () => {
    const input = pending("injected-failed-trace.json");
    const seen: ModelCompletionRequest[] = [];
    await diagnoseTrace(input, {
      model: scripted(seen, {
        category: "ToolUse",
        cause: "The checkout result does not match a later read.",
        step_id: "step-4",
        confidence: 0.7,
        evidence: ["step-4 returns ord_fake."],
        proposed_fixes: ["pre_response_check"],
      }),
      modelName: config.modelName,
    });
    const request = seen[0]!;
    const view = readView(request);
    assertNoBannedKeys(view);
    const packet = `${request.system}\n${request.user}`;
    for (const canary of [
      "forged_tool_result",
      "orders is empty; ord_fake does not exist in the mock.",
      "cart sess-demo still has SKU-MUG-01 qty 2.",
      "No placed order to compare with the cart total of 24 USD.",
      "12oz stoneware mug",
      "CANARY",
    ]) {
      assert.equal(packet.includes(canary), false, canary);
    }
    assert.equal(request.user.includes("ord_fake"), true);
    assert.equal(request.user.includes("step-4"), true);
    assert.equal(request.user.includes("agent_claimed_success"), true);
    assert.equal(view.findings.some((item) => item.kind === "tool_error"), false);
    assert.equal(view.findings.some((item) => item.kind === "repeated_tool_call"), false);
  });

  it("flags a timeout, a repeated identical tool call, and a tool timeout", async () => {
    const input = loadTrace("timeout-repeated-tool-trace.json");
    const seen: ModelCompletionRequest[] = [];
    const output = await diagnoseTrace(input, {
      model: scripted(seen, {
        category: "Execution",
        cause: "The same catalog search was issued again and the harness stopped on a timeout.",
        step_id: "step-5",
        confidence: 0.66,
        evidence: ["step-5 says the time limit was hit.", "step-1 and step-3 search for mug."],
        proposed_fixes: ["controlled_retry"],
      }),
      modelName: config.modelName,
    });
    const findings = readView(seen[0]!).findings;
    assert.deepEqual(
      findings.map((item) => ({ kind: item.kind, step_ids: item.step_ids })),
      [
        { kind: "repeated_tool_call", step_ids: ["step-1", "step-3"] },
        { kind: "timeout", step_ids: ["step-5"] },
        { kind: "timeout", step_ids: ["step-4"] },
      ],
    );
    assert.equal(output.diagnosis.confidence, 0.66);
    assert.equal(packetHas(seen[0]!, "CANARY_VERIFIER_DETAIL_timeout"), false);
    assert.equal(packetHas(seen[0]!, "CANARY_SNAPSHOT_timeout"), false);
    assert.equal(output.outcome, input.outcome);
    assert.equal(output.fault, input.fault);
  });

  it("flags a failed tool result", async () => {
    const input = loadTrace("tool-error-trace.json");
    const seen: ModelCompletionRequest[] = [];
    const output = await diagnoseTrace(input, {
      model: scripted(seen, {
        category: "ToolUse",
        cause: "Checkout returned an error and the agent stopped.",
        step_id: "step-2",
        confidence: 0.55,
        evidence: ["step-2 is the checkout error."],
        proposed_fixes: ["controlled_retry"],
      }),
      modelName: config.modelName,
    });
    const findings = readView(seen[0]!).findings;
    assert.deepEqual(
      findings.map((item) => ({ kind: item.kind, step_ids: item.step_ids })),
      [{ kind: "tool_error", step_ids: ["step-2"] }],
    );
    assert.ok(output.diagnosis.evidence.includes(findings[0]!.detail));
    assert.equal(packetHas(seen[0]!, "CANARY_VERIFIER_DETAIL_tool"), false);
    assert.equal(output.fault, input.fault);
  });

  it("drops evidence that cites no real step and caps confidence", async () => {
    const input = pending("injected-failed-trace.json");
    const seen: ModelCompletionRequest[] = [];
    const output = await diagnoseTrace(input, {
      model: scripted(seen, {
        category: "Verification",
        cause: "The success claim is not backed by a real order.",
        step_id: "step-5",
        confidence: 0.9,
        evidence: ["no step here", "step-5 is the claim"],
        proposed_fixes: [],
      }),
      modelName: config.modelName,
    });
    assert.equal(output.diagnosis.evidence.includes("no step here"), false);
    assert.equal(output.diagnosis.evidence.includes("step-5 is the claim"), true);
    assert.equal(output.diagnosis.confidence, 0.4);
    assert.equal(output.diagnosis.step_id, "step-5");
  });

  it("replaces an unknown culprit with the pre-pass step and caps confidence", async () => {
    const input = pending("injected-failed-trace.json");
    const output = await diagnoseTrace(input, {
      model: scripted([], {
        category: "Verification",
        cause: "The model named a step that never happened.",
        step_id: "step-999",
        confidence: 0.95,
        evidence: ["step-999 was imagined", "step-4 still shows ord_fake."],
        proposed_fixes: ["pre_response_check"],
      }),
      modelName: config.modelName,
    });
    assert.equal(output.diagnosis.step_id, "step-5");
    assert.equal(output.diagnosis.confidence, 0.4);
    assert.equal(output.diagnosis.evidence.includes("step-999 was imagined"), false);
    assert.equal(output.diagnosis.evidence.includes("step-4 still shows ord_fake."), true);
    assert.equal(output.fault, input.fault);
    assert.equal(output.outcome.verifier, input.outcome.verifier);
  });

  it("rejects an unknown culprit when pre-pass has no step to substitute", async () => {
    const input = mustTrace(minimalTrace({ steps: [], status: "error" }));
    await assert.rejects(
      () =>
        diagnoseTrace(input, {
          model: scripted([], {
            category: "Reasoning",
            cause: "Nothing in the trace explains this.",
            step_id: "step-missing",
            confidence: 0.2,
            evidence: ["step-missing only"],
            proposed_fixes: [],
          }),
          modelName: config.modelName,
        }),
      (error: unknown) => error instanceof DiagnosisFailed && error.code === "rejected",
    );
    assert.equal(input.diagnosis, null);
    assert.equal(input.fault.injected, false);
  });

  it("rejects issue field names and does not copy them onto the trace", async () => {
    const input = pending("injected-failed-trace.json");
    const frozenFault = input.fault;
    const frozenVerifier = input.outcome.verifier;
    await assert.rejects(
      () =>
        diagnoseTrace(input, {
          model: scripted([], {
            category: "Verification",
            cause: "Old field names are not the schema.",
            culprit_step_id: "step-5",
            confidence: 0.4,
            evidence: ["step-5"],
            suggested_fix_ids: ["pre_response_check"],
          }),
          modelName: config.modelName,
        }),
      (error: unknown) => error instanceof DiagnosisFailed,
    );
    assert.equal(input.fault, frozenFault);
    assert.equal(input.outcome.verifier, frozenVerifier);
    assert.equal(input.diagnosis, null);
  });

  it("does not record usage when the model omits it", async () => {
    const input = loadTrace("tool-error-trace.json");
    let calls = 0;
    await diagnoseTrace(input, {
      model: scripted([], {
        category: "ToolUse",
        cause: "Checkout returned an error.",
        step_id: "step-2",
        confidence: 0.4,
        evidence: ["step-2 failed."],
        proposed_fixes: [],
      }),
      modelName: config.modelName,
      onUsage() {
        calls += 1;
      },
    });
    assert.equal(calls, 0);
  });
});

function scripted(
  seen: ModelCompletionRequest[],
  body: unknown,
  usage: ModelUsage | null = null,
): DiagnosisModel {
  return {
    async complete(request) {
      seen.push(request);
      return { content: JSON.stringify(body), usage };
    },
  };
}

function loadTrace(name: string): Trace {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`../../../packages/shared/examples/${name}`, import.meta.url), "utf8"),
  );
  return mustTrace(raw);
}

function pending(name: string): Trace {
  const trace = structuredClone(loadTrace(name));
  trace.diagnosis = null;
  return mustTrace(trace);
}

function mustTrace(value: unknown): Trace {
  const parsed = validateTrace(value);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  return parsed.value;
}

function minimalTrace(overrides: { steps: unknown[]; status: string }): unknown {
  return {
    trace_id: "trace-empty",
    agent_id: "reference-shop",
    run_id: "run-empty",
    task_id: "T1",
    started_at: "2026-11-04T12:00:00.000Z",
    ended_at: "2026-11-04T12:00:01.000Z",
    status: overrides.status,
    steps: overrides.steps,
    outcome: {
      success: false,
      verifier: { passed: false, checks: [], mock_state_snapshot: {} },
      agent_claimed_success: false,
    },
    totals: { latency_ms: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    fault: { injected: false, labels: [], attacker: { used: false, payload_id: null } },
    diagnosis: null,
  };
}

function readView(request: ModelCompletionRequest): { findings: FindingView[] } {
  const parsed: unknown = JSON.parse(request.user);
  if (!isRecord(parsed) || !Array.isArray(parsed.findings)) {
    throw new Error("model user message was not a prompt view");
  }
  const findings: FindingView[] = [];
  for (const item of parsed.findings) {
    if (!isFinding(item)) {
      throw new Error("finding was not the prompt shape");
    }
    findings.push(item);
  }
  return { findings };
}

interface FindingView {
  kind: string;
  step_ids: string[];
  detail: string;
}

function isFinding(value: unknown): value is FindingView {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.detail !== "string") {
    return false;
  }
  return Array.isArray(value.step_ids) && value.step_ids.every((id) => typeof id === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoBannedKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoBannedKeys(item);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.equal(BANNED_KEYS.has(key), false, key);
    assertNoBannedKeys(child);
  }
}

function packetHas(request: ModelCompletionRequest, needle: string): boolean {
  return `${request.system}\n${request.user}`.includes(needle);
}
