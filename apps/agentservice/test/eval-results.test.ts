import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { parseDiagnosisConfig } from "../src/grok/config.js";

const config = parseDiagnosisConfig({
  XAI_API_KEY: "",
  GROK_MODEL: "grok-test",
});

const validLatest = {
  schema_version: 1,
  generated_at: "2026-11-04T14:05:27.488Z",
  dataset: {
    scored_count: 19,
    categories: ["Plan"],
    category_counts: { Plan: 2 },
  },
  methods: {
    baseline: {
      category_correct: 4,
      scored: 19,
      step_exact: 5,
      step_tolerance_1: 10,
      fix_hits: 4,
      fix_applicable: 7,
    },
  },
};

const validBaseline = {
  schema_version: 1,
  description: "Test baseline.",
  threshold: {
    max_rate_drop: { numerator: 0, denominator: 1 },
    note: "Exact match.",
  },
  metrics: [
    { id: "category_accuracy", scoreboard: "Accuratezza di categoria", hits: 4, total: 19 },
    { id: "step_accuracy_exact", scoreboard: "Step esatto", hits: 5, total: 19 },
    { id: "step_accuracy_tolerance_1", scoreboard: "Step entro ±1", hits: 10, total: 19 },
    { id: "proposed_fix_hit_rate", scoreboard: "Hit del fix proposto", hits: 4, total: 7 },
  ],
};

describe("GET /eval/results", () => {
  it("returns 200 with committed latest.json plus baseline when present", async () => {
    await withApp(buildApp({ config, model: null, logger: false }), async (app) => {
      const response = await app.inject({ method: "GET", url: "/eval/results" });
      assert.equal(response.statusCode, 200);
      const body = response.json() as Record<string, unknown>;
      assert.equal(body.schema_version, 1);
      assert.equal(typeof body.generated_at, "string");
      assert.ok(isRecord(body.dataset));
      assert.equal(body.dataset.scored_count, 19);
      assert.ok(Array.isArray(body.metrics));
      assert.equal(body.metrics.length, 4);
      const category = body.metrics.find((row: { id: string }) => row.id === "category_accuracy");
      assert.ok(category);
      assert.ok(isRecord(category.baseline));
      assert.equal(category.baseline.hits, 4);
      assert.equal(category.baseline.total, 19);
      assert.equal(category.baseline.rate, 4 / 19);
      assert.ok(isRecord(body.report));
      assert.equal(body.report.schema_version, 1);
      assert.ok(isRecord(body.baseline));
      assert.equal(body.baseline.schema_version, 1);
      assert.ok(Array.isArray(body.baseline.metrics));
    });
  });

  it("returns 404 when latest.json is missing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-results-"));
    await withApp(
      buildApp({
        config,
        model: null,
        logger: false,
        evalResults: {
          latestPath: path.join(dir, "missing-latest.json"),
          baselinePath: path.join(dir, "missing-baseline.json"),
        },
      }),
      async (app) => {
        const response = await app.inject({ method: "GET", url: "/eval/results" });
        assert.equal(response.statusCode, 404);
        assert.equal(response.json().error, "eval_results_not_found");
        assert.equal(typeof response.json().message, "string");
        assert.doesNotMatch(response.body, /\/tmp|\\\\/);
      },
    );
  });

  it("returns 500 when latest.json is not valid JSON", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-results-"));
    const latestPath = path.join(dir, "latest.json");
    writeFileSync(latestPath, "{not-json");
    await withApp(
      buildApp({
        config,
        model: null,
        logger: false,
        evalResults: { latestPath, baselinePath: path.join(dir, "baseline.json") },
      }),
      async (app) => {
        const response = await app.inject({ method: "GET", url: "/eval/results" });
        assert.equal(response.statusCode, 500);
        assert.equal(response.json().error, "invalid_eval_results");
      },
    );
  });

  it("returns 500 when latest.json fails the scoreboard schema", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-results-"));
    const latestPath = path.join(dir, "latest.json");
    writeFileSync(latestPath, JSON.stringify({ schema_version: 1, generated_at: "now" }));
    await withApp(
      buildApp({
        config,
        model: null,
        logger: false,
        evalResults: { latestPath, baselinePath: path.join(dir, "baseline.json") },
      }),
      async (app) => {
        const response = await app.inject({ method: "GET", url: "/eval/results" });
        assert.equal(response.statusCode, 500);
        assert.equal(response.json().error, "invalid_eval_results");
      },
    );
  });

  it("omits baseline when that file is missing and still returns 200", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-results-"));
    mkdirSync(dir, { recursive: true });
    const latestPath = path.join(dir, "latest.json");
    writeFileSync(latestPath, JSON.stringify(validLatest));
    await withApp(
      buildApp({
        config,
        model: null,
        logger: false,
        evalResults: { latestPath, baselinePath: path.join(dir, "baseline.json") },
      }),
      async (app) => {
        const response = await app.inject({ method: "GET", url: "/eval/results" });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().baseline, null);
        assert.equal(response.json().metrics[0].id, "category_accuracy");
      },
    );
  });

  it("returns 500 when baseline.json exists but is invalid", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-results-"));
    const latestPath = path.join(dir, "latest.json");
    const baselinePath = path.join(dir, "baseline.json");
    writeFileSync(latestPath, JSON.stringify(validLatest));
    writeFileSync(baselinePath, JSON.stringify({ schema_version: 1 }));
    await withApp(
      buildApp({
        config,
        model: null,
        logger: false,
        evalResults: { latestPath, baselinePath },
      }),
      async (app) => {
        const response = await app.inject({ method: "GET", url: "/eval/results" });
        assert.equal(response.statusCode, 500);
        assert.equal(response.json().error, "invalid_eval_baseline");
      },
    );
  });

  it("attaches a valid baseline.json next to the report", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-results-"));
    const latestPath = path.join(dir, "latest.json");
    const baselinePath = path.join(dir, "baseline.json");
    writeFileSync(latestPath, JSON.stringify(validLatest));
    writeFileSync(baselinePath, JSON.stringify(validBaseline));
    await withApp(
      buildApp({
        config,
        model: null,
        logger: false,
        evalResults: { latestPath, baselinePath },
      }),
      async (app) => {
        const response = await app.inject({ method: "GET", url: "/eval/results" });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json().baseline.metrics[0], validBaseline.metrics[0]);
      },
    );
  });
});

async function withApp(app: FastifyInstance, run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
