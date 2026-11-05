import { readFileSync, writeFileSync } from "node:fs";
import type { MethodSummary } from "./evaluate.js";

/**
 * Committed rules-only reference for the CI gate.
 * `pnpm eval` rewrites the scoreboard and can call Grok. It does not rewrite this file.
 */
export const BASELINE_PATH = "apps/agentservice/eval/baseline.json";

export const GATED_METRICS = [
  {
    id: "category_accuracy",
    scoreboard: "Accuratezza di categoria",
    hitsKey: "category_correct",
    totalKey: "scored",
  },
  {
    id: "step_accuracy_exact",
    scoreboard: "Step esatto",
    hitsKey: "step_exact",
    totalKey: "scored",
  },
  {
    id: "step_accuracy_tolerance_1",
    scoreboard: "Step entro ±1",
    hitsKey: "step_tolerance_1",
    totalKey: "scored",
  },
  {
    id: "proposed_fix_hit_rate",
    scoreboard: "Hit del fix proposto",
    hitsKey: "fix_hits",
    totalKey: "fix_applicable",
  },
] as const;

export type GatedMetricId = (typeof GATED_METRICS)[number]["id"];

export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
}

export interface BaselineMetric {
  readonly id: GatedMetricId;
  readonly scoreboard: string;
  readonly hits: number;
  readonly total: number;
}

export interface EvalBaselineFile {
  readonly schema_version: 1;
  readonly description: string;
  readonly threshold: {
    readonly max_rate_drop: Rate;
    readonly note: string;
  };
  readonly metrics: readonly BaselineMetric[];
}

export interface MetricDelta {
  readonly id: GatedMetricId;
  readonly scoreboard: string;
  readonly committedHits: number;
  readonly committedTotal: number;
  readonly freshHits: number;
  readonly freshTotal: number;
  readonly drop: Rate;
}

export interface GateVerdict {
  readonly ok: boolean;
  readonly threshold: Rate;
  readonly failures: readonly MetricDelta[];
  readonly metrics: readonly BaselineMetric[];
}

const ROOT_KEYS = ["schema_version", "description", "threshold", "metrics"] as const;
const THRESHOLD_KEYS = ["max_rate_drop", "note"] as const;
const RATE_KEYS = ["numerator", "denominator"] as const;
const METRIC_KEYS = ["id", "scoreboard", "hits", "total"] as const;

export function isGatedMetricId(value: string | undefined): value is GatedMetricId {
  return GATED_METRICS.some((metric) => metric.id === value);
}

export type GatedSummaryCounts = Pick<
  MethodSummary,
  "category_correct" | "scored" | "step_exact" | "step_tolerance_1" | "fix_hits" | "fix_applicable"
>;

export function metricsFromSummary(summary: GatedSummaryCounts): BaselineMetric[] {
  return GATED_METRICS.map((metric) => ({
    id: metric.id,
    scoreboard: metric.scoreboard,
    hits: summary[metric.hitsKey],
    total: summary[metric.totalKey],
  }));
}

/** Lowers one fresh hit count. This is the offline way to see the gate fail. */
export function applyHitDrop(metrics: readonly BaselineMetric[], id: GatedMetricId): BaselineMetric[] {
  let found = false;
  const next = metrics.map((metric) => {
    if (metric.id !== id) {
      return metric;
    }
    found = true;
    if (metric.hits < 1) {
      throw new Error(`Cannot drop a hit from ${id}: hits is ${metric.hits}.`);
    }
    return { ...metric, hits: metric.hits - 1 };
  });
  if (!found) {
    throw new Error(`Unknown metric ${id}.`);
  }
  return next;
}

/**
 * A numerator of 0 requires the same hits and the same total.
 * A positive threshold fails only when the absolute rate difference is greater
 * than `max_rate_drop`. An equal difference passes.
 */
export function compareToBaseline(committed: EvalBaselineFile, fresh: readonly BaselineMetric[]): GateVerdict {
  const freshById = new Map(fresh.map((metric) => [metric.id, metric]));
  const failures: MetricDelta[] = [];
  for (const metric of committed.metrics) {
    const current = freshById.get(metric.id);
    if (current === undefined) {
      throw new Error(`Fresh eval is missing ${metric.id}.`);
    }
    assertFraction(metric.hits, metric.total, metric.id);
    assertFraction(current.hits, current.total, metric.id);
    const drop = absoluteRateDifference(
      { numerator: metric.hits, denominator: metric.total },
      { numerator: current.hits, denominator: current.total },
    );
    const beyond =
      committed.threshold.max_rate_drop.numerator === 0
        ? metric.hits !== current.hits || metric.total !== current.total
        : rateGreaterThan(drop, committed.threshold.max_rate_drop);
    if (beyond) {
      failures.push({
        id: metric.id,
        scoreboard: metric.scoreboard,
        committedHits: metric.hits,
        committedTotal: metric.total,
        freshHits: current.hits,
        freshTotal: current.total,
        drop,
      });
    }
  }
  return {
    ok: failures.length === 0,
    threshold: committed.threshold.max_rate_drop,
    failures,
    metrics: [...fresh],
  };
}

export function formatGateReport(input: {
  verdict: GateVerdict;
  grokReason: string;
  simulated: GatedMetricId | null;
  baselinePath: string;
}): string {
  const threshold = formatRate(input.verdict.threshold);
  const lines: string[] = [];
  if (input.simulated !== null) {
    lines.push(`eval gate: simulated a 1-hit drop on ${input.simulated}`);
  }
  if (input.verdict.ok) {
    lines.push(`eval gate: rules baseline matches ${input.baselinePath} (max_rate_drop ${threshold})`);
    for (const metric of input.verdict.metrics) {
      lines.push(`- ${metric.id} (${metric.scoreboard}): ${metric.hits}/${metric.total}`);
    }
  } else {
    lines.push(`eval gate: regression beyond max_rate_drop ${threshold} (${input.baselinePath})`);
    for (const failure of input.verdict.failures) {
      const exact =
        input.verdict.threshold.numerator === 0
          ? `; max_rate_drop ${threshold} requires the same hits and the same total`
          : "";
      lines.push(
        `- ${failure.id} (${failure.scoreboard}): committed ${failure.committedHits}/${failure.committedTotal}, fresh ${failure.freshHits}/${failure.freshTotal}, absolute difference ${formatRate(failure.drop)}${exact}`,
      );
    }
    if (input.simulated === null) {
      lines.push(
        `Update ${input.baselinePath} with \`pnpm eval:gate -- --write\` when the fresh rates should replace the committed baseline.`,
      );
    }
  }
  lines.push(`grok: skipped (${input.grokReason})`);
  return lines.join("\n");
}

export function loadBaseline(filePath: string): EvalBaselineFile {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return parseBaseline(parsed);
}

export function parseBaseline(value: unknown): EvalBaselineFile {
  const root = record(value, "baseline");
  assertExactKeys(root, ROOT_KEYS, "baseline");
  if (root.schema_version !== 1) {
    throw new Error("Invalid baseline: schema_version must be 1.");
  }
  if (typeof root.description !== "string" || root.description.trim().length === 0) {
    throw new Error("Invalid baseline: description must be a non-empty string.");
  }
  const threshold = record(root.threshold, "threshold");
  assertExactKeys(threshold, THRESHOLD_KEYS, "threshold");
  if (typeof threshold.note !== "string" || threshold.note.trim().length === 0) {
    throw new Error("Invalid baseline: threshold.note must be a non-empty string.");
  }
  const maxRateDrop = parseRate(threshold.max_rate_drop, "threshold.max_rate_drop");
  if (!Array.isArray(root.metrics)) {
    throw new Error("Invalid baseline: metrics must be an array.");
  }
  if (root.metrics.length !== GATED_METRICS.length) {
    throw new Error(`Invalid baseline: metrics must list ${GATED_METRICS.map((metric) => metric.id).join(", ")}.`);
  }
  const metrics = root.metrics.map((entry, index) => parseMetric(entry, index));
  return {
    schema_version: 1,
    description: root.description,
    threshold: { max_rate_drop: maxRateDrop, note: threshold.note },
    metrics,
  };
}

export function serializeBaseline(file: EvalBaselineFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Replaces metric counts. Description and threshold stay as committed. */
export function writeBaselineCounts(filePath: string, current: EvalBaselineFile, metrics: readonly BaselineMetric[]): void {
  const next: EvalBaselineFile = {
    schema_version: 1,
    description: current.description,
    threshold: {
      max_rate_drop: {
        numerator: current.threshold.max_rate_drop.numerator,
        denominator: current.threshold.max_rate_drop.denominator,
      },
      note: current.threshold.note,
    },
    metrics: GATED_METRICS.map((expected) => {
      const metric = metrics.find((item) => item.id === expected.id);
      if (metric === undefined) {
        throw new Error(`Cannot write baseline without ${expected.id}.`);
      }
      assertFraction(metric.hits, metric.total, metric.id);
      return {
        id: expected.id,
        scoreboard: expected.scoreboard,
        hits: metric.hits,
        total: metric.total,
      };
    }),
  };
  const serialized = serializeBaseline(next);
  parseBaseline(JSON.parse(serialized));
  writeFileSync(filePath, serialized);
}

function parseMetric(value: unknown, index: number): BaselineMetric {
  const expected = GATED_METRICS[index];
  if (expected === undefined) {
    throw new Error(`Invalid baseline: unexpected metric at index ${index}.`);
  }
  const metric = record(value, `metrics[${index}]`);
  assertExactKeys(metric, METRIC_KEYS, `metrics[${index}]`);
  if (metric.id !== expected.id) {
    throw new Error(`Invalid baseline: metrics[${index}].id must be ${expected.id}.`);
  }
  if (metric.scoreboard !== expected.scoreboard) {
    throw new Error(`Invalid baseline: metrics[${index}].scoreboard must be ${expected.scoreboard}.`);
  }
  if (!isWhole(metric.hits) || !isWhole(metric.total)) {
    throw new Error(`Invalid baseline: ${expected.id} hits and total must be whole numbers.`);
  }
  assertFraction(metric.hits, metric.total, expected.id);
  return {
    id: expected.id,
    scoreboard: expected.scoreboard,
    hits: metric.hits,
    total: metric.total,
  };
}

function parseRate(value: unknown, label: string): Rate {
  const rate = record(value, label);
  assertExactKeys(rate, RATE_KEYS, label);
  if (!isWhole(rate.numerator) || !isWhole(rate.denominator) || rate.denominator < 1) {
    throw new Error(`Invalid baseline: ${label} must be a non-negative integer over a positive integer.`);
  }
  return { numerator: rate.numerator, denominator: rate.denominator };
}

function assertFraction(hits: number, total: number, label: string): void {
  if (!isWhole(hits) || !isWhole(total) || total < 1 || hits > total) {
    throw new Error(`Invalid fraction for ${label}: ${hits}/${total}.`);
  }
}

function absoluteRateDifference(left: Rate, right: Rate): Rate {
  const numerator = Math.abs(left.numerator * right.denominator - right.numerator * left.denominator);
  const denominator = left.denominator * right.denominator;
  return reduceRate(numerator, denominator);
}

function rateGreaterThan(left: Rate, right: Rate): boolean {
  return left.numerator * right.denominator > right.numerator * left.denominator;
}

function reduceRate(numerator: number, denominator: number): Rate {
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function gcd(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function formatRate(rate: Rate): string {
  return `${rate.numerator}/${rate.denominator}`;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !allowed.has(key))) {
    throw new Error(`Invalid baseline: ${label} keys must be ${keys.join(", ")}.`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid baseline: ${label} must be an object.`);
  }
  const entries = Object.entries(value);
  return Object.fromEntries(entries);
}

function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
