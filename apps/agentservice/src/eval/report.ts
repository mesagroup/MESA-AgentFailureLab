import { FAULT_CATEGORIES } from "@mesa/shared";
import { baselineMappingLines } from "./rules.js";
import {
  METRIC_DEFINITIONS,
  MEASUREMENT,
  type ConfusionColumn,
  type EvalReport,
  type MethodSummary,
} from "./evaluate.js";

export const SCOREBOARD_START = "<!-- eval-scoreboard:start -->";
export const SCOREBOARD_END = "<!-- eval-scoreboard:end -->";

const CONFUSION_COLUMNS: readonly ConfusionColumn[] = [
  ...FAULT_CATEGORIES,
  "abstain",
  "error",
];

export function formatMs(value: number): string {
  return value.toFixed(3);
}

export function formatCost(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return value.toFixed(6);
}

export function formatTokens(summary: MethodSummary): string {
  if (summary.tokens.input === null || summary.tokens.output === null) {
    return "n/a";
  }
  return `${summary.tokens.input}/${summary.tokens.output}`;
}

export function baselineScoreLines(report: EvalReport): string[] {
  const baseline = report.methods.baseline;
  return [
    `Scored traces: ${report.dataset.scored_count}`,
    `Categories: ${report.dataset.categories.length} (${report.dataset.categories.join(", ")})`,
    `Baseline category accuracy: ${baseline.category_correct}/${baseline.scored}`,
    `Baseline step accuracy exact: ${baseline.step_exact}/${baseline.scored}`,
    `Baseline step accuracy tolerance 1: ${baseline.step_tolerance_1}/${baseline.scored}`,
    `Baseline proposed-fix hits: ${baseline.fix_hits}/${baseline.fix_applicable}`,
    `Baseline proposed-fix not applicable: ${baseline.fix_not_applicable}`,
    `Traces with injector hints: ${report.dataset.leakage.traces_with_hints}/${report.dataset.scored_count}`,
  ];
}

export function grokStatusLine(report: EvalReport): string {
  const grok = report.methods.grok;
  if (grok.mode === "skipped") {
    return `Grok: skipped (${grok.reason})`;
  }
  const name = grok.model ?? "unnamed";
  return `Grok: ${grok.mode} (${name}) category accuracy: ${grok.category_correct}/${grok.scored}`;
}

export function timingLines(report: EvalReport): string[] {
  const baseline = report.methods.baseline;
  const lines = [
    `Baseline mean latency ms: ${formatMs(baseline.mean_latency_ms)}`,
    `Baseline tokens in/out: ${formatTokens(baseline)}`,
    `Baseline cost usd: ${formatCost(baseline.cost_usd.total)}`,
  ];
  const grok = report.methods.grok;
  if (grok.mode !== "skipped") {
    lines.push(
      `Grok mean latency ms: ${formatMs(grok.mean_latency_ms)}`,
      `Grok tokens in/out: ${formatTokens(grok)}`,
      `Grok cost usd: ${formatCost(grok.cost_usd.total)}`,
    );
  }
  return lines;
}

export function renderScoreboard(report: EvalReport): string {
  const definitions = Object.entries(METRIC_DEFINITIONS).map(([key, text]) => `- \`${key}\`: ${text}`);
  const mapping = baselineMappingLines().map((line) => `- ${line}`);
  const scores = [...baselineScoreLines(report).map((line) => `- ${line}`), `- ${grokStatusLine(report)}`];
  const timing = timingLines(report).map((line) => `- ${line}`);
  return [
    "Definitions",
    ...definitions,
    "",
    "Rules baseline mapping. The first diagnosis finding in repair priority is the prediction. No finding abstains.",
    ...mapping,
    "",
    "Scores",
    ...scores,
    "",
    "Timing (one pass; latency describes that pass and is not a tuned benchmark)",
    ...timing,
  ].join("\n");
}

export function renderDetails(report: EvalReport): string {
  const measurement = [
    `- Passes: ${MEASUREMENT.passes}`,
    `- Timed region: ${MEASUREMENT.timed_region}`,
    `- Baseline limiter: ${MEASUREMENT.baseline_limiter}`,
    `- Grok limiter: ${MEASUREMENT.grok_limiter}`,
    `- Cost: ${MEASUREMENT.cost_policy}`,
    `- Errors: ${MEASUREMENT.errors_policy}`,
    `- Generated at: ${report.generated_at}`,
  ];
  const hintRows = Object.entries(report.dataset.leakage.by_hint).map(([id, count]) => `| ${id} | ${count} |`);
  const parts = [
    "## Measurement",
    ...measurement,
    "",
    "## Leakage",
    report.dataset.leakage.note,
    "",
    "| Hint | Traces |",
    "| --- | --- |",
    ...hintRows,
    "",
    "## Category support",
    "| Category | Traces |",
    "| --- | --- |",
    ...report.dataset.categories.map(
      (category) => `| ${category} | ${report.dataset.category_counts[category]} |`,
    ),
    "",
    "## Confusion (baseline)",
    "Rows are the labelled category. Columns are the prediction. The diagonal is a category hit.",
    "",
    renderConfusion(report.methods.baseline),
    "",
  ];
  const grok = report.methods.grok;
  if (grok.mode !== "skipped") {
    parts.push(`## Confusion (${grok.mode})`, "", renderConfusion(grok), "");
  }
  parts.push("## Traces", "", renderCases(report), "");
  return parts.join("\n");
}

export function spliceMarked(source: string, start: string, end: string, body: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  if (startAt < 0 || endAt < 0 || endAt <= startAt) {
    throw new Error(`Missing markers ${start} … ${end}`);
  }
  return `${source.slice(0, startAt + start.length)}\n${body}\n${source.slice(endAt)}`;
}

export function markerBody(source: string): string {
  const startAt = source.indexOf(SCOREBOARD_START);
  const endAt = source.indexOf(SCOREBOARD_END);
  if (startAt < 0 || endAt < 0 || endAt <= startAt) {
    throw new Error("Scoreboard markers are missing.");
  }
  return source.slice(startAt + SCOREBOARD_START.length, endAt).trim();
}

function renderConfusion(summary: MethodSummary): string {
  const header = ["gt \\\\ predicted", ...CONFUSION_COLUMNS, "support"];
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const category of FAULT_CATEGORIES) {
    const row = summary.confusion[category];
    const support =
      row.Plan +
      row.ToolUse +
      row.Context +
      row.Reasoning +
      row.Execution +
      row.Verification +
      row.Security +
      row.abstain +
      row.error;
    if (support === 0) {
      continue;
    }
    const cells = CONFUSION_COLUMNS.map((column) => String(row[column]));
    lines.push(`| ${category} | ${cells.join(" | ")} | ${support} |`);
  }
  return lines.join("\n");
}

function renderCases(report: EvalReport): string {
  const grok = report.methods.grok;
  const withModel = grok.mode !== "skipped";
  const header = [
    "id",
    "source",
    "category",
    "code",
    "step",
    "baseline",
    "baseline step",
    "exact",
    "±1",
    "fix",
    "hints",
  ];
  if (withModel) {
    header.push("model", "model step");
  }
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const item of report.cases) {
    const prediction = item.baseline.prediction;
    const predicted = prediction.kind === "prediction" ? prediction.category : prediction.kind;
    const predictedStep = prediction.kind === "prediction" ? prediction.step_id : "";
    const hints = item.hints.length === 0 ? "none" : item.hints.join(", ");
    const cells = [
      item.id,
      item.truth.source,
      item.truth.category,
      item.truth.code,
      item.truth.step_id,
      predicted,
      predictedStep,
      item.baseline.step_exact ? "yes" : "no",
      item.baseline.step_tolerance_1 ? "yes" : "no",
      formatFix(item.baseline.fix_hit),
      hints,
    ];
    if (withModel && item.grok !== null) {
      const modelPrediction = item.grok.prediction;
      cells.push(
        modelPrediction.kind === "prediction" ? modelPrediction.category : modelPrediction.kind,
        modelPrediction.kind === "prediction" ? modelPrediction.step_id : "",
      );
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function formatFix(hit: boolean | null): string {
  if (hit === null) {
    return "n/a";
  }
  return hit ? "hit" : "miss";
}
