import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import type { Trace } from "@mesa/shared";
import { FAULT_CATEGORIES } from "@mesa/shared";
import { validateTrace } from "@mesa/shared/validate";
import type { DiagnosisModel, ModelCompletionRequest } from "../src/diagnosis/diagnose.js";
import { resolveGrok } from "../src/eval/cli.js";
import { DATASET_PLAN } from "../src/eval/dataset-plan.js";
import { METRIC_DEFINITIONS, evaluateDataset, scoreJudgement } from "../src/eval/evaluate.js";
import { loadDataset } from "../src/eval/load-dataset.js";
import { MANIFEST_PATH } from "../src/eval/dataset-plan.js";
import { GROK_PLACEHOLDER, SCOREBOARD_METRIC_DEFINITIONS, formatCost, formatMs, limitsBody, markerBody } from "../src/eval/report.js";
import { repoRoot } from "../src/eval/repo-root.js";
import { LEAKAGE_NOTE, baselineMappingLines, hintsInSteps, rulesBaseline } from "../src/eval/rules.js";

before(() => {
  globalThis.fetch = () => Promise.reject(new Error("network disabled"));
});

const root = repoRoot(import.meta.url);

describe("dataset", () => {
  it("covers 15 to 20 labelled traces and at least four categories", () => {
    assert.ok(DATASET_PLAN.length >= 15);
    assert.ok(DATASET_PLAN.length <= 20);
    const loaded = loadDataset(root, MANIFEST_PATH);
    assert.deepEqual(
      loaded.map((item) => item.id),
      DATASET_PLAN.map((item) => item.id),
    );
    const categories = new Set(loaded.map((item) => item.truth.category));
    assert.ok(categories.size >= 4);
    for (const category of categories) {
      assert.ok(FAULT_CATEGORIES.includes(category));
    }
    const jury = loaded.find((item) => item.id === "jury-unauthorized-cancel");
    const shared = loaded.find((item) => item.id === "shared-t3-forged-checkout");
    assert.equal(jury?.truth.source, "fault.attacker");
    assert.equal(shared?.truth.source, "fault.labels");
    assert.deepEqual(shared?.hints, []);
    const dropped = loaded.find((item) => item.id === "t3-execution-drop-checkout");
    assert.deepEqual(dropped?.hints, []);
    assert.equal(
      loaded.every((item) => item.hints.length === 0),
      true,
    );
  });
});

describe("rules baseline", () => {
  it("maps the first diagnosis finding and does not read fault labels", () => {
    const forged = loadExample("injected-failed-trace.json");
    const forgedBaseline = rulesBaseline(forged);
    assert.equal(forgedBaseline.kind, "prediction");
    if (forgedBaseline.kind !== "prediction") {
      return;
    }
    assert.equal(forgedBaseline.finding, "false_success_claim");
    assert.equal(forgedBaseline.category, "Verification");
    assert.equal(forgedBaseline.step_id, "step-5");
    assert.deepEqual(forgedBaseline.proposed_fixes, ["pre_response_check"]);

    const relabelled = structuredClone(forged);
    const label = relabelled.fault.labels[0];
    assert.ok(label);
    label.category = "Security";
    label.code = "unauthorized_cancel_via_juror_note";
    relabelled.fault.attacker = { used: true, payload_id: "jury-nota-malevola-cancel" };
    assert.deepEqual(rulesBaseline(relabelled), forgedBaseline);

    const toolError = rulesBaseline(loadExample("tool-error-trace.json"));
    assert.equal(toolError.kind, "prediction");
    if (toolError.kind === "prediction") {
      assert.equal(toolError.finding, "tool_error");
      assert.equal(toolError.category, "Execution");
      assert.equal(toolError.step_id, "step-2");
      assert.deepEqual(toolError.proposed_fixes, ["controlled_retry"]);
    }

    const repeated = rulesBaseline(loadExample("timeout-repeated-tool-trace.json"));
    assert.equal(repeated.kind, "prediction");
    if (repeated.kind === "prediction") {
      assert.equal(repeated.finding, "repeated_tool_call");
      assert.equal(repeated.category, "Reasoning");
      assert.equal(repeated.step_id, "step-1");
      assert.deepEqual(repeated.proposed_fixes, []);
    }
  });

  it("counts an adjacent step.index and ignores a missing step id", () => {
    const trace = mustTrace(threeSteps());
    const truth = {
      source: "fault.labels" as const,
      category: "Execution" as const,
      step_id: "b",
      code: "dropped_tool_call",
      attacker_used: false,
      payload_id: null,
    };
    const adjacent = scoreJudgement(trace, truth, {
      kind: "prediction",
      category: "Execution",
      step_id: "c",
      proposed_fixes: ["controlled_retry"],
    });
    assert.equal(adjacent.step_exact, false);
    assert.equal(adjacent.step_tolerance_1, true);
    assert.equal(adjacent.category_match, true);
    assert.equal(adjacent.fix_hit, true);

    const missing = scoreJudgement(trace, truth, {
      kind: "prediction",
      category: "Execution",
      step_id: "missing",
      proposed_fixes: ["permission_guard"],
    });
    assert.equal(missing.step_exact, false);
    assert.equal(missing.step_tolerance_1, false);
    assert.equal(missing.fix_hit, false);

    const planTruth = { ...truth, category: "Plan" as const, code: "omitted_required_step" };
    const notApplicable = scoreJudgement(trace, planTruth, {
      kind: "abstain",
      reason: "no_findings",
    });
    assert.equal(notApplicable.category_match, false);
    assert.equal(notApplicable.fix_hit, null);
  });
});

describe("hints", () => {
  it("flags injector booleans and the dropped-call message on steps only", () => {
    const trace = mustTrace(threeSteps());
    assert.deepEqual(hintsInSteps(trace.steps), []);
    const flagged = structuredClone(trace);
    const step = flagged.steps[1];
    assert.ok(step);
    step.tool_output = { forged: true, stale: true, injected: true, message: "Injected execution drop before the mock was called." };
    assert.deepEqual(hintsInSteps(flagged.steps), ["dropped_message", "forged_true", "stale_true", "injected_true"]);
    flagged.fault.labels = [
      { category: "ToolUse", step_id: "b", code: "forged:true" },
    ];
    assert.equal(hintsInSteps(flagged.steps).includes("forged_true"), true);
  });
});

describe("evaluate", () => {
  it("skips Grok without a key and writes no live score", async () => {
    const report = await evaluateDataset({
      repoRoot: root,
      manifestPath: MANIFEST_PATH,
      grok: { mode: "skipped", reason: "XAI_API_KEY is unset" },
      generatedAt: "2026-11-04T00:00:00.000Z",
    });
    assert.equal(report.methods.grok.mode, "skipped");
    assert.equal(report.methods.baseline.mode, "rules");
    assert.equal(report.methods.baseline.live, false);
    assert.equal(report.methods.baseline.tokens.input, null);
    assert.equal(report.methods.baseline.cost_usd.total, null);
    assert.equal(report.methods.baseline.errors, 0);
    assert.equal(report.dataset.scored_count, DATASET_PLAN.length);
    assert.ok(report.dataset.categories.length >= 4);
    assert.equal(report.methods.baseline.scored, report.cases.length);
    let categoryCorrect = 0;
    let hinted = 0;
    for (const item of report.cases) {
      assert.equal(item.grok, null);
      if (item.hints.length > 0) {
        hinted += 1;
      }
      if (item.baseline.prediction.kind === "prediction" && item.baseline.prediction.category === item.truth.category) {
        categoryCorrect += 1;
      }
    }
    assert.equal(report.methods.baseline.category_correct, categoryCorrect);
    assert.equal(report.dataset.leakage.traces_with_hints, hinted);
    assert.ok(report.dataset.leakage.note.includes("@diamanti-sg"));
  });

  it("keeps label codes out of the model prompt and labels the fake", async () => {
    const seen: ModelCompletionRequest[] = [];
    const model: DiagnosisModel = {
      async complete(request) {
        seen.push(request);
        const stepId = firstStepId(request.user);
        return {
          content: JSON.stringify({
            category: "Plan",
            cause: "Fake diagnosis used by the eval test. This is not a Grok result.",
            step_id: stepId,
            confidence: 0.1,
            evidence: [`${stepId} fake diagnosis`],
            proposed_fixes: [],
          }),
          usage: { input_tokens: 2, output_tokens: 3, cost_usd: 0.5 },
        };
      },
    };
    const report = await evaluateDataset({
      repoRoot: root,
      manifestPath: MANIFEST_PATH,
      grok: { mode: "fake", model, modelName: "fake-diagnosis" },
      generatedAt: "2026-11-04T00:00:00.000Z",
    });
    const grok = report.methods.grok;
    assert.equal(grok.mode, "fake");
    if (grok.mode !== "fake") {
      return;
    }
    assert.equal(grok.live, false);
    assert.equal(grok.model, "fake-diagnosis");
    assert.equal(grok.errors, 0);
    assert.equal(grok.tokens.input, 2 * report.cases.length);
    assert.equal(grok.tokens.output, 3 * report.cases.length);
    assert.equal(grok.cost_usd.total, 0.5 * report.cases.length);
    assert.equal(seen.length, report.cases.length);
    const packet = seen.map((request) => request.user).join("\n");
    assert.equal(packet.includes("Injected execution drop before the mock was called."), false);
    assert.equal(packet.includes('"forged":true'), false);
    assert.equal(packet.includes("Injector skipped "), false);
    const secrets = new Set<string>();
    for (const item of report.cases) {
      secrets.add(item.truth.code);
      if (item.truth.payload_id !== null) {
        secrets.add(item.truth.payload_id);
      }
    }
    for (const request of seen) {
      for (const secret of secrets) {
        assert.equal(request.user.includes(secret), false, secret);
      }
      const view: unknown = JSON.parse(request.user);
      assertNoAnswerKey(view);
    }
  });
});

describe("published numbers", () => {
  it("matches a fresh baseline and the committed latency", async () => {
    const fresh = await evaluateDataset({
      repoRoot: root,
      manifestPath: MANIFEST_PATH,
      grok: { mode: "skipped", reason: "XAI_API_KEY is unset" },
      generatedAt: "2026-11-04T00:00:00.000Z",
    });
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const latestMd = readFileSync(new URL("../eval/results/latest.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const latestJson: unknown = JSON.parse(readFileSync(new URL("../eval/results/latest.json", import.meta.url), "utf8"));
    assert.equal(markerBody(readme), markerBody(latestMd));
    assert.equal(limitsBody(readme), limitsBody(latestMd));
    const board = markerBody(readme);
    const limits = limitsBody(readme);
    const scored = fresh.methods.baseline.scored;
    const lines = [
      `Scored set: ${fresh.dataset.scored_count} traces, ${fresh.dataset.categories.length} categories (${fresh.dataset.categories.join(", ")}).`,
      `| Category accuracy | ${fresh.methods.baseline.category_correct}/${scored} |`,
      `| Exact step | ${fresh.methods.baseline.step_exact}/${scored} |`,
      `| Step within ±1 | ${fresh.methods.baseline.step_tolerance_1}/${scored} |`,
      `| Proposed-fix hit | ${fresh.methods.baseline.fix_hits}/${fresh.methods.baseline.fix_applicable} |`,
    ];
    const grokMode = readString(latestJson, ["methods", "grok", "mode"]);
    if (grokMode === "skipped") {
      lines.push(GROK_PLACEHOLDER);
    } else if (grokMode === "live") {
      const model = readString(latestJson, ["methods", "grok", "model"]);
      assert.notEqual(model, "");
      const grokScored = readNumber(latestJson, ["methods", "grok", "scored"]);
      const grokApplicable = readNumber(latestJson, ["methods", "grok", "fix_applicable"]);
      const category = `${readNumber(latestJson, ["methods", "grok", "category_correct"])}/${grokScored}`;
      const stepExact = `${readNumber(latestJson, ["methods", "grok", "step_exact"])}/${grokScored}`;
      const stepTolerance = `${readNumber(latestJson, ["methods", "grok", "step_tolerance_1"])}/${grokScored}`;
      const fixHits = `${readNumber(latestJson, ["methods", "grok", "fix_hits"])}/${grokApplicable}`;
      lines.push(
        `**Grok column — live** (\`${model}\`)`,
        `| Category accuracy | ${fresh.methods.baseline.category_correct}/${scored} | ${category} |`,
        `| Exact step | ${fresh.methods.baseline.step_exact}/${scored} | ${stepExact} |`,
        `| Step within ±1 | ${fresh.methods.baseline.step_tolerance_1}/${scored} | ${stepTolerance} |`,
        `| Proposed-fix hit | ${fresh.methods.baseline.fix_hits}/${fresh.methods.baseline.fix_applicable} | ${fixHits} |`,
      );
      assert.equal(board.includes(GROK_PLACEHOLDER), false);
    } else {
      assert.fail(`published Grok mode must be skipped or live, got ${grokMode}`);
    }
    for (const line of lines) {
      assert.ok(board.includes(line), line);
    }
    for (const text of Object.values(SCOREBOARD_METRIC_DEFINITIONS)) {
      assert.ok(board.includes(text));
    }
    for (const text of Object.values(METRIC_DEFINITIONS)) {
      assert.ok(latestMd.includes(text));
    }
    for (const line of baselineMappingLines()) {
      assert.ok(board.includes(line));
    }
    assert.ok(limits.includes(`${fresh.dataset.leakage.traces_with_hints}/${fresh.dataset.scored_count}`));
    assert.ok(board.includes("PR #44"));
    assert.ok(limits.includes("PR #44"));
    assert.ok(limits.includes("@diamanti-sg"));
    assert.ok(limits.includes("PR #21"));
    assert.ok(limits.includes("#15"));
    assert.ok(limits.includes("ADR-001"));
    if (grokMode === "skipped") {
      assert.ok(limits.includes("n/a"));
    } else {
      const cost = formatCost(readNumber(latestJson, ["methods", "grok", "cost_usd", "total"]));
      const tokensIn = readNumber(latestJson, ["methods", "grok", "tokens", "input"]);
      const tokensOut = readNumber(latestJson, ["methods", "grok", "tokens", "output"]);
      assert.ok(
        limits.includes(
          `Grok cost reported by the provider: ${cost} USD (total), tokens in/out ${tokensIn}/${tokensOut}. The rules-only baseline reports neither tokens nor cost.`,
        ),
      );
    }
    assert.ok(readme.includes("## Dataset and results"));
    assert.ok(readme.includes("## Known limits"));
    assert.ok(latestMd.includes(LEAKAGE_NOTE));
    const storedLatency = readNumber(latestJson, ["methods", "baseline", "mean_latency_ms"]);
    assert.ok(board.includes(`| Mean latency (ms) | ${formatMs(storedLatency)} |`));
    assert.equal(readNumber(latestJson, ["methods", "baseline", "category_correct"]), fresh.methods.baseline.category_correct);
    assert.equal(readNumber(latestJson, ["methods", "baseline", "step_exact"]), fresh.methods.baseline.step_exact);
    assert.equal(readNumber(latestJson, ["methods", "baseline", "step_tolerance_1"]), fresh.methods.baseline.step_tolerance_1);
    assert.equal(readNumber(latestJson, ["methods", "baseline", "fix_hits"]), fresh.methods.baseline.fix_hits);
    assert.equal(readNumber(latestJson, ["dataset", "scored_count"]), fresh.dataset.scored_count);
  });
});

describe("grok resolution", () => {
  it("skips an empty key and labels --fake without calling the network", () => {
    const skipped = resolveGrok({ fake: false }, { XAI_API_KEY: "  " });
    assert.equal(skipped.mode, "skipped");
    const fake = resolveGrok({ fake: true }, { XAI_API_KEY: "present-but-unused" });
    assert.equal(fake.mode, "fake");
    if (fake.mode === "fake") {
      assert.equal(fake.modelName, "fake-diagnosis");
    }
  });
});

function loadExample(name: string): Trace {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`../../../packages/shared/examples/${name}`, import.meta.url), "utf8"),
  );
  return mustTrace(raw);
}

function mustTrace(value: unknown): Trace {
  const parsed = validateTrace(value);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  return parsed.value;
}

function threeSteps(): unknown {
  const step = (stepId: string, index: number) => ({
    step_id: stepId,
    index,
    type: "message",
    timestamp: "2026-11-04T12:00:00.000Z",
    role: "user",
    content: stepId,
    latency_ms: 1,
    token_usage: { input: 0, output: 0 },
    cost_usd: 0,
  });
  return {
    trace_id: "trace-score",
    agent_id: "reference-shop",
    run_id: "run-score",
    task_id: "T1",
    started_at: "2026-11-04T12:00:00.000Z",
    ended_at: "2026-11-04T12:00:01.000Z",
    status: "failed",
    steps: [step("a", 0), step("b", 1), step("c", 2)],
    outcome: {
      success: false,
      verifier: { passed: false, checks: [], mock_state_snapshot: {} },
      agent_claimed_success: false,
    },
    totals: { latency_ms: 3, tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    fault: {
      injected: true,
      labels: [{ category: "Execution", step_id: "b", code: "dropped_tool_call" }],
      attacker: { used: false, payload_id: null },
    },
    diagnosis: null,
  };
}

function firstStepId(user: string): string {
  const parsed: unknown = JSON.parse(user);
  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) {
    return "missing-step";
  }
  const first = parsed.steps[0];
  if (!isRecord(first) || typeof first.step_id !== "string") {
    return "missing-step";
  }
  return first.step_id;
}

function assertNoAnswerKey(value: unknown): void {
  const banned = new Set(["fault", "labels", "attacker", "payload_id", "verifier", "diagnosis"]);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoAnswerKey(item);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.equal(banned.has(key), false, key);
    assertNoAnswerKey(child);
  }
}

function readNumber(value: unknown, path: readonly string[]): number {
  const current = readPath(value, path);
  if (typeof current !== "number") {
    throw new Error(`${path.join(".")} is not a number`);
  }
  return current;
}

function readString(value: unknown, path: readonly string[]): string {
  const current = readPath(value, path);
  if (typeof current !== "string") {
    throw new Error(`${path.join(".")} is not a string`);
  }
  return current;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      throw new Error(`Missing ${path.join(".")}`);
    }
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
