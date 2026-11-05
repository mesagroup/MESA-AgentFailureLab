import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GATED_METRICS, metricsFromSummary, parseBaseline, type EvalBaselineFile, type GatedSummaryCounts } from "./gate.js";

export const DEFAULT_LATEST_PATH = fileURLToPath(new URL("../../eval/results/latest.json", import.meta.url));
export const DEFAULT_BASELINE_PATH = fileURLToPath(new URL("../../eval/baseline.json", import.meta.url));

export interface EvalResultsFiles {
  latestPath?: string;
  baselinePath?: string;
}

export interface EvalResultsMetric {
  id: ReturnType<typeof metricsFromSummary>[number]["id"];
  label: string;
  baseline: { hits: number; total: number; rate: number };
  grok: { hits: number; total: number; rate: number } | null;
}

export interface EvalResultsDataset {
  scored_count: number;
  categories: string[];
  category_counts: Record<string, number>;
}

export interface EvalResultsResponse {
  schema_version: 1;
  generated_at: string;
  dataset: EvalResultsDataset;
  metrics: EvalResultsMetric[];
  /** Full committed `eval/results/latest.json` after parse. Grok column, latency, and cost live here. */
  report: Record<string, unknown>;
  /** Committed `eval/baseline.json` for the CI gate / FE comparison column. `null` when that file is absent. */
  baseline: EvalBaselineFile | null;
}

export type EvalResultsLoad =
  | { ok: true; body: EvalResultsResponse }
  | { ok: false; status: 404 | 500; error: string; message: string };

/**
 * HTTP scoreboard for issue #57. `latest.json` is the `pnpm eval` report (schema_version,
 * generated_at, dataset, methods, cases). It does not list `metrics[]`; those four rates
 * are derived from `methods.baseline` using the same ids as `baseline.json`.
 */
export function loadEvalResults(files: EvalResultsFiles = {}): EvalResultsLoad {
  const latestPath = files.latestPath ?? DEFAULT_LATEST_PATH;
  const baselinePath = files.baselinePath ?? DEFAULT_BASELINE_PATH;
  const latestRaw = readJsonFile(latestPath);
  if (latestRaw.kind === "missing") {
    return {
      ok: false,
      status: 404,
      error: "eval_results_not_found",
      message: "No eval results have been published yet. Run `pnpm eval` to write eval/results/latest.json.",
    };
  }
  if (latestRaw.kind === "invalid_json") {
    return {
      ok: false,
      status: 500,
      error: "invalid_eval_results",
      message: "Eval results file is not valid JSON.",
    };
  }
  const report = parseLatestReport(latestRaw.value);
  if (!report.ok) {
    return { ok: false, status: 500, error: "invalid_eval_results", message: report.message };
  }
  const baselineRaw = readJsonFile(baselinePath);
  if (baselineRaw.kind === "invalid_json") {
    return {
      ok: false,
      status: 500,
      error: "invalid_eval_baseline",
      message: "Eval baseline file is not valid JSON.",
    };
  }
  let baseline: EvalBaselineFile | null = null;
  if (baselineRaw.kind === "ok") {
    try {
      baseline = parseBaseline(baselineRaw.value);
    } catch {
      return {
        ok: false,
        status: 500,
        error: "invalid_eval_baseline",
        message: "Eval baseline file failed validation.",
      };
    }
  }
  return {
    ok: true,
    body: {
      schema_version: 1,
      generated_at: report.generated_at,
      dataset: report.dataset,
      metrics: report.metrics,
      report: report.report,
      baseline,
    },
  };
}

function readJsonFile(filePath: string): { kind: "missing" } | { kind: "invalid_json" } | { kind: "ok"; value: unknown } {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid_json" };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid_json" };
  }
}

function parseLatestReport(
  value: unknown,
):
  | { ok: true; generated_at: string; dataset: EvalResultsDataset; metrics: EvalResultsMetric[]; report: Record<string, unknown> }
  | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "Eval results must be a JSON object." };
  }
  if (value.schema_version !== 1) {
    return { ok: false, message: "Eval results schema_version must be 1." };
  }
  if (typeof value.generated_at !== "string" || value.generated_at.trim().length === 0) {
    return { ok: false, message: "Eval results generated_at must be a non-empty string." };
  }
  const dataset = parseDataset(value.dataset);
  if (!dataset.ok) return dataset;
  const methods = isRecord(value.methods) ? value.methods : null;
  if (methods === null) {
    return { ok: false, message: "Eval results methods must be an object." };
  }
  const baseline = parseBaselineSummary(methods.baseline);
  if (!baseline.ok) return baseline;
  const grokParsed = parseBaselineSummary(methods.grok);
  const grokSummary = grokParsed.ok ? grokParsed.summary : null;
  const baselineMetrics = metricsFromSummary(baseline.summary);
  const metrics = baselineMetrics.map((bm) => {
    const gated = GATED_METRICS.find((g) => g.id === bm.id)!;
    const grokHits = grokSummary ? grokSummary[gated.hitsKey] : null;
    const grokTotal = grokSummary ? grokSummary[gated.totalKey] : null;
    return {
      id: bm.id,
      label: bm.scoreboard,
      baseline: { hits: bm.hits, total: bm.total, rate: bm.total > 0 ? bm.hits / bm.total : 0 },
      grok:
        grokHits !== null && grokTotal !== null
          ? { hits: grokHits, total: grokTotal, rate: grokTotal > 0 ? grokHits / grokTotal : 0 }
          : null,
    };
  });
  return {
    ok: true,
    generated_at: value.generated_at,
    dataset: dataset.value,
    metrics,
    report: value,
  };
}

function parseDataset(value: unknown): { ok: true; value: EvalResultsDataset } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "Eval results dataset must be an object." };
  }
  if (!isWhole(value.scored_count)) {
    return { ok: false, message: "Eval results dataset.scored_count must be a non-negative integer." };
  }
  if (!Array.isArray(value.categories) || value.categories.some((entry) => typeof entry !== "string")) {
    return { ok: false, message: "Eval results dataset.categories must be an array of strings." };
  }
  if (!isRecord(value.category_counts) || Object.values(value.category_counts).some((count) => !isWhole(count))) {
    return { ok: false, message: "Eval results dataset.category_counts must map names to non-negative integers." };
  }
  return {
    ok: true,
    value: {
      scored_count: value.scored_count,
      categories: value.categories,
      category_counts: value.category_counts as Record<string, number>,
    },
  };
}

function parseBaselineSummary(value: unknown): { ok: true; summary: GatedSummaryCounts } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "Eval results methods.baseline must be an object." };
  }
  const keys = ["category_correct", "scored", "step_exact", "step_tolerance_1", "fix_hits", "fix_applicable"] as const;
  for (const key of keys) {
    if (!isWhole(value[key])) {
      return { ok: false, message: `Eval results methods.baseline.${key} must be a non-negative integer.` };
    }
  }
  return {
    ok: true,
    summary: {
      category_correct: value.category_correct as number,
      scored: value.scored as number,
      step_exact: value.step_exact as number,
      step_tolerance_1: value.step_tolerance_1 as number,
      fix_hits: value.fix_hits as number,
      fix_applicable: value.fix_applicable as number,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
