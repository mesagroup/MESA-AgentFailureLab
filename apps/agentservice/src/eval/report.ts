import { FAULT_CATEGORIES } from "@mesa/shared";
import { baselineMappingLines } from "./rules.js";
import {
  METRIC_DEFINITIONS,
  MEASUREMENT,
  type ConfusionColumn,
  type EvalReport,
  type MethodSummary,
} from "./evaluate.js";
import { GATED_METRICS } from "./gate.js";

export const SCOREBOARD_START = "<!-- eval-scoreboard:start -->";
export const SCOREBOARD_END = "<!-- eval-scoreboard:end -->";
export const LIMITS_START = "<!-- eval-limits:start -->";
export const LIMITS_END = "<!-- eval-limits:end -->";

/** Cell used when Grok did not run. `pnpm eval` with `XAI_API_KEY` replaces it. */
export const GROK_PLACEHOLDER = "*(placeholder: `pnpm eval` with XAI_API_KEY)*";

/** Metric prose for the README scoreboard. Counts stay in the generated table. */
export const SCOREBOARD_METRIC_DEFINITIONS = METRIC_DEFINITIONS;

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

export function renderScoreboard(report: EvalReport): string {
  const definitions = Object.entries(SCOREBOARD_METRIC_DEFINITIONS).map(([key, text]) => `- \`${key}\`: ${text}`);
  const mapping = baselineMappingLines().map((line) => `- ${line}`);
  const fixtures = report.cases.filter((item) => item.origin === "fixture");
  const generated = report.cases.length - fixtures.length;
  const fixtureList = fixtures.map((item) => `\`${item.relative_path}\``).join(", ");
  const categories = report.dataset.categories.join(", ");
  return [
    `Scored set: ${report.dataset.scored_count} traces, ${report.dataset.categories.length} categories (${categories}).`,
    "",
    `Provenance: ${fixtures.length} fixtures already in the repository (${fixtureList}) and ${generated} traces from the scripted harness. Regenerate the harness traces and the manifest with \`pnpm generate-dataset\` (loopback mock, \`scripted\` driver, catalog faults). Then \`pnpm eval\` rewrites this section.`,
    "",
    "The rules-only baseline counts were recomputed after [PR #44](https://github.com/mesagroup/MESA-AgentFailureLab/pull/44). That PR stopped copying injector markers into steps, and `pnpm generate-dataset` regenerated the harness traces on that code.",
    "",
    "Ground truth is the single label in `fault.labels`. If `fault.attacker.used` is true, the source in the manifest is `fault.attacker`: that object has no category, and ADR-002 assigns the label to the attacker. The evaluator reads `fault`. Grok's prompt does not.",
    "",
    "### Definitions",
    ...definitions,
    "",
    "The rules-only baseline takes the first finding from `diagnosisFindings`, in this order. With no finding the method abstains.",
    ...mapping,
    "",
    grokBanner(report),
    "",
    renderComparisonTable(report),
  ].join("\n");
}

export function renderLimits(report: EvalReport): string {
  const hints = report.dataset.leakage.traces_with_hints;
  const scored = report.dataset.scored_count;
  return [
    `- Injector hints in ${hints}/${scored} traces. Before [PR #44](https://github.com/mesagroup/MESA-AgentFailureLab/pull/44) they were 13/19: markers in the steps (\`Injected execution drop…\`, \`Injector skipped\`, \`forged: true\`, \`stale: true\`, \`injected: true\`) reached Grok. That PR (@diamanti-sg) no longer copies them. This eval does not change \`apps/backend\`.`,
    "- The scripted driver has little variety until the reference agent lands ([PR #21](https://github.com/mesagroup/MESA-AgentFailureLab/pull/21)). `pnpm generate-dataset` does not copy that agent.",
    "- Fix effectiveness needs the verifier replay ([#15](https://github.com/mesagroup/MESA-AgentFailureLab/issues/15)). The fix row in the table only says whether the proposal contains the ADR-002 fix for the labelled category.",
    `- One pass (count: ${MEASUREMENT.passes}). ADR-001 excludes multi-run aggregation.`,
    `- ${costLimit(report)}`,
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
    "## Definitions (en)",
    ...Object.entries(METRIC_DEFINITIONS).map(([key, text]) => `- \`${key}\`: ${text}`),
    "",
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
  return markedBody(source, SCOREBOARD_START, SCOREBOARD_END, "Scoreboard markers are missing.");
}

export function limitsBody(source: string): string {
  return markedBody(source, LIMITS_START, LIMITS_END, "Limits markers are missing.");
}

function markedBody(source: string, start: string, end: string, missing: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  if (startAt < 0 || endAt < 0 || endAt <= startAt) {
    throw new Error(missing);
  }
  return source.slice(startAt + start.length, endAt).trim();
}

function renderComparisonTable(report: EvalReport): string {
  const baseline = report.methods.baseline;
  const [category, exact, tolerance, fixHit] = GATED_METRICS;
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    [category.scoreboard, fraction(baseline.category_correct, baseline.scored), grokFraction(report, "category_correct", "scored")],
    [exact.scoreboard, fraction(baseline.step_exact, baseline.scored), grokFraction(report, "step_exact", "scored")],
    [tolerance.scoreboard, fraction(baseline.step_tolerance_1, baseline.scored), grokFraction(report, "step_tolerance_1", "scored")],
    [fixHit.scoreboard, fraction(baseline.fix_hits, baseline.fix_applicable), grokFraction(report, "fix_hits", "fix_applicable")],
    ["Fix not applicable", String(baseline.fix_not_applicable), grokCount(report, "fix_not_applicable")],
    ["Mean latency (ms)", formatMs(baseline.mean_latency_ms), grokLatency(report)],
    ["Tokens in/out", formatTokens(baseline), grokTokens(report)],
    ["Cost USD", formatCost(baseline.cost_usd.total), grokCost(report)],
  ];
  const lines = ["| Metric | Baseline (rules only) | Grok |", "| --- | --- | --- |"];
  for (const [metric, rules, model] of rows) {
    lines.push(`| ${metric} | ${rules} | ${model} |`);
  }
  return lines.join("\n");
}

function grokBanner(report: EvalReport): string {
  const grok = report.methods.grok;
  if (grok.mode === "skipped") {
    return "> **Grok column — placeholder.** Not a result. Fill it by running `pnpm eval` with `XAI_API_KEY` set.";
  }
  if (grok.mode === "fake") {
    return "> **Grok column — fake.** Not a Grok score. The labelled model is `fake-diagnosis`.";
  }
  const name = grok.model ?? "unnamed";
  return `> **Grok column — live** (\`${name}\`), one pass. Errors in the denominator: ${grok.errors}.`;
}

function grokFraction(
  report: EvalReport,
  correctKey: "category_correct" | "step_exact" | "step_tolerance_1" | "fix_hits",
  totalKey: "scored" | "fix_applicable",
): string {
  const grok = report.methods.grok;
  if (grok.mode === "skipped") {
    return GROK_PLACEHOLDER;
  }
  const text = fraction(grok[correctKey], grok[totalKey]);
  return grok.mode === "fake" ? `fake ${text}` : text;
}

function grokCount(report: EvalReport, key: "fix_not_applicable"): string {
  const grok = report.methods.grok;
  if (grok.mode === "skipped") {
    return GROK_PLACEHOLDER;
  }
  const text = String(grok[key]);
  return grok.mode === "fake" ? `fake ${text}` : text;
}

function grokLatency(report: EvalReport): string {
  const grok = report.methods.grok;
  if (grok.mode === "skipped") {
    return GROK_PLACEHOLDER;
  }
  const text = formatMs(grok.mean_latency_ms);
  return grok.mode === "fake" ? `fake ${text}` : text;
}

function grokTokens(report: EvalReport): string {
  const grok = report.methods.grok;
  if (grok.mode === "skipped") {
    return GROK_PLACEHOLDER;
  }
  const text = formatTokens(grok);
  return grok.mode === "fake" ? `fake ${text}` : text;
}

function grokCost(report: EvalReport): string {
  const grok = report.methods.grok;
  if (grok.mode === "skipped") {
    return GROK_PLACEHOLDER;
  }
  const text = formatCost(grok.cost_usd.total);
  return grok.mode === "fake" ? `fake ${text}` : text;
}

function costLimit(report: EvalReport): string {
  const grok = report.methods.grok;
  if (grok.mode === "skipped") {
    return "Without `XAI_API_KEY` Grok cost is n/a. The rules-only baseline reports neither tokens nor cost.";
  }
  if (grok.mode === "fake") {
    return "The Grok column of this run is fake: the cost is not an xAI cost. The rules-only baseline reports neither tokens nor cost.";
  }
  return `Grok cost reported by the provider: ${formatCost(grok.cost_usd.total)} USD (total), tokens in/out ${formatTokens(grok)}. The rules-only baseline reports neither tokens nor cost.`;
}

function fraction(correct: number, total: number): string {
  return `${correct}/${total}`;
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
