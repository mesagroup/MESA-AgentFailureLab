import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { MANIFEST_PATH } from "../src/eval/dataset-plan.js";
import { evaluateDataset } from "../src/eval/evaluate.js";
import { runGate } from "../src/eval/gate-cli.js";
import {
  BASELINE_PATH,
  applyHitDrop,
  compareToBaseline,
  loadBaseline,
  metricsFromSummary,
  parseBaseline,
  serializeBaseline,
  writeBaselineCounts,
  type BaselineMetric,
  type EvalBaselineFile,
} from "../src/eval/gate.js";
import { markerBody } from "../src/eval/report.js";
import { repoRoot } from "../src/eval/repo-root.js";

before(() => {
  globalThis.fetch = () => Promise.reject(new Error("network disabled"));
});

const root = repoRoot(import.meta.url);
const baselinePath = path.join(root, BASELINE_PATH);

describe("baseline file", () => {
  it("is canonical, documented, and matches the scoreboard baseline column", () => {
    const text = readFileSync(baselinePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    const baseline = parseBaseline(parsed);
    assert.equal(serializeBaseline(baseline), text);
    assert.match(baseline.description, /max_rate_drop|threshold/i);
    assert.match(baseline.description, /XAI_API_KEY|Grok skipped/);
    assert.match(baseline.description, /scoreboard/i);
    assert.equal(baseline.threshold.max_rate_drop.numerator, 0);
    assert.equal(baseline.threshold.max_rate_drop.denominator, 1);
    assert.match(baseline.threshold.note, /simulate-drop/);
    const board = markerBody(readFileSync(path.join(root, "README.md"), "utf8"));
    for (const metric of baseline.metrics) {
      assert.equal(board.includes(`| ${metric.scoreboard} | ${metric.hits}/${metric.total} |`), true, metric.id);
    }
  });

  it("rejects an unknown key", () => {
    const baseline = loadBaseline(baselinePath);
    const extra: Record<string, unknown> = { ...baseline, owner: "ci" };
    assert.throws(() => parseBaseline(extra), /keys must be/);
  });
});

describe("regression threshold", () => {
  it("passes when the fresh rules rates match the committed file", async () => {
    const committed = loadBaseline(baselinePath);
    const report = await evaluateDataset({
      repoRoot: root,
      manifestPath: MANIFEST_PATH,
      grok: { mode: "skipped", reason: "XAI_API_KEY is unset" },
      generatedAt: "2026-11-04T00:00:00.000Z",
    });
    const verdict = compareToBaseline(committed, metricsFromSummary(report.methods.baseline));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.failures.length, 0);
  });

  it("fails when the committed baseline hits are lowered by one", () => {
    const committed = loadBaseline(baselinePath);
    const fresh = committed.metrics.map((metric) => ({ ...metric }));
    const lowered = replaceHits(committed, "category_accuracy", (hits) => hits - 1);
    const verdict = compareToBaseline(lowered, fresh);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failures.length, 1);
    const failure = verdict.failures[0];
    assert.ok(failure);
    assert.equal(failure.id, "category_accuracy");
    assert.equal(failure.committedHits, 3);
    assert.equal(failure.freshHits, 4);
    assert.deepEqual(failure.drop, { numerator: 1, denominator: 19 });
  });

  it("treats a difference equal to a positive threshold as inside the gate", () => {
    const committed = withThreshold(loadBaseline(baselinePath), 1, 19);
    const fresh = applyHitDrop(committed.metrics, "category_accuracy");
    const held = compareToBaseline(committed, fresh);
    assert.equal(held.ok, true);
    const droppedAgain = applyHitDrop(fresh, "category_accuracy");
    const beyond = compareToBaseline(committed, droppedAgain);
    assert.equal(beyond.ok, false);
    assert.equal(beyond.failures[0]?.freshHits, 2);
    assert.deepEqual(beyond.failures[0]?.drop, { numerator: 2, denominator: 19 });
  });

  it("with a zero threshold, rejects a rescaled fraction that has the same rate", () => {
    const committed = loadBaseline(baselinePath);
    const fresh = committed.metrics.map((metric) =>
      metric.id === "category_accuracy" ? { ...metric, hits: metric.hits * 2, total: metric.total * 2 } : { ...metric },
    );
    const verdict = compareToBaseline(committed, fresh);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failures[0]?.id, "category_accuracy");
  });
});

describe("eval gate command", () => {
  it("passes offline and does not call the network when a key is present", async () => {
    const previous = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "sk-test-not-a-real-key";
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      return Promise.reject(new Error("network disabled"));
    };
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runGate({
        repoRoot: root,
        baselinePath,
        write: false,
        simulateDrop: null,
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      assert.equal(code, 0);
      assert.equal(calls, 0);
      assert.equal(stderr.length, 0);
      const report = stdout.join("");
      assert.match(report, /rules baseline matches/);
      assert.match(report, /category_accuracy \(Accuratezza di categoria\): 4\/19/);
      assert.match(report, /grok: skipped \(XAI_API_KEY is unset\)/);
      assert.equal(report.includes("sk-test-not-a-real-key"), false);
    } finally {
      if (previous === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = previous;
      }
    }
  });

  it("fails when a fresh hit is lowered past the threshold", async () => {
    const stderr: string[] = [];
    const code = await runGate({
      repoRoot: root,
      baselinePath,
      write: false,
      simulateDrop: "category_accuracy",
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
    });
    assert.equal(code, 1);
    const report = stderr.join("");
    assert.match(report, /simulated a 1-hit drop on category_accuracy/);
    assert.match(report, /regression beyond max_rate_drop 0\/1/);
    assert.match(report, /committed 4\/19, fresh 3\/19, absolute difference 1\/19/);
    assert.match(report, /grok: skipped \(XAI_API_KEY is unset\)/);
  });

  it("writes fresh counts without dropping the documented threshold", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mesa-eval-gate-"));
    const target = path.join(dir, "baseline.json");
    const committed = loadBaseline(baselinePath);
    const lowered = replaceHits(committed, "step_accuracy_exact", (hits) => hits - 1);
    writeFileSync(target, serializeBaseline(lowered));
    const stdout: string[] = [];
    const code = await runGate({
      repoRoot: root,
      baselinePath: target,
      write: true,
      simulateDrop: null,
      stdout: (text) => stdout.push(text),
      stderr: (text) => {
        throw new Error(text);
      },
    });
    assert.equal(code, 0);
    const written = loadBaseline(target);
    assert.equal(written.description, committed.description);
    assert.deepEqual(written.threshold, committed.threshold);
    assert.equal(written.metrics.find((metric) => metric.id === "step_accuracy_exact")?.hits, 4);
    assert.match(stdout.join(""), /wrote/);
  });

  it("refuses to write a simulated drop", async () => {
    const stderr: string[] = [];
    const code = await runGate({
      repoRoot: root,
      baselinePath,
      write: true,
      simulateDrop: "step_accuracy_exact",
      stderr: (text) => stderr.push(text),
    });
    assert.equal(code, 1);
    assert.match(stderr.join(""), /cannot be combined/);
    const still = loadBaseline(baselinePath);
    assert.equal(still.metrics.find((metric) => metric.id === "step_accuracy_exact")?.hits, 4);
  });
});

describe("writeBaselineCounts", () => {
  it("keeps the scoreboard labels from the gate, not from the caller", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mesa-eval-gate-"));
    const target = path.join(dir, "baseline.json");
    const committed = loadBaseline(baselinePath);
    const metrics: BaselineMetric[] = committed.metrics.map((metric) => ({
      ...metric,
      scoreboard: "renamed",
      hits: metric.hits,
    }));
    writeBaselineCounts(target, committed, metrics);
    const written = loadBaseline(target);
    assert.equal(written.metrics[0]?.scoreboard, "Accuratezza di categoria");
  });
});

function replaceHits(file: EvalBaselineFile, id: BaselineMetric["id"], next: (hits: number) => number): EvalBaselineFile {
  return {
    ...file,
    metrics: file.metrics.map((metric) => (metric.id === id ? { ...metric, hits: next(metric.hits) } : metric)),
  };
}

function withThreshold(file: EvalBaselineFile, numerator: number, denominator: number): EvalBaselineFile {
  return {
    ...file,
    threshold: {
      ...file.threshold,
      max_rate_drop: { numerator, denominator },
    },
  };
}
