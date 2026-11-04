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
export const LIMITS_START = "<!-- eval-limits:start -->";
export const LIMITS_END = "<!-- eval-limits:end -->";

/** Cell used when Grok did not run. `pnpm eval` with `XAI_API_KEY` replaces it. */
export const GROK_PLACEHOLDER = "*(segnaposto: `pnpm eval` con XAI_API_KEY)*";

/** Metric prose for the jury README. Counts stay in the generated table. */
export const ITALIAN_METRIC_DEFINITIONS = {
  category_accuracy:
    "La categoria predetta è uguale all'unica categoria in `fault.labels`. Astensione e diagnosi fallita contano come errori. Il denominatore è ogni trace del set.",
  step_accuracy_exact: "Lo `step_id` predetto è uguale allo `step_id` dell'etichetta.",
  step_accuracy_tolerance_1:
    "La differenza assoluta di `step.index` fra predizione ed etichetta è al massimo 1, incluso l'esatto. Uno `step_id` che non è sulla trace è un errore.",
  proposed_fix_hit_rate:
    "`proposed_fixes` contiene il fix ADR-002 della categoria etichettata: Execution → `controlled_retry`, Verification → `pre_response_check`, Security → `permission_guard`. Plan, ToolUse, Context e Reasoning non hanno un fix MVP e restano fuori dal denominatore. Un fix in più non annulla l'hit. Non è il replay del verificatore.",
  mean_latency_ms:
    "Media aritmetica di una sola passata, dopo che la trace è già caricata. Non è una mediana e non è un benchmark.",
  tokens_and_cost:
    "Token e `cost_usd` sono solo quelli riportati dal provider. Se l'usage manca il valore resta assente. I token non vengono convertiti in un prezzo.",
} as const;

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
  const definitions = Object.entries(ITALIAN_METRIC_DEFINITIONS).map(([key, text]) => `- \`${key}\`: ${text}`);
  const mapping = baselineMappingLines().map((line) => `- ${line}`);
  const fixtures = report.cases.filter((item) => item.origin === "fixture");
  const generated = report.cases.length - fixtures.length;
  const fixtureList = fixtures.map((item) => `\`${item.relative_path}\``).join(", ");
  const categories = report.dataset.categories.join(", ");
  return [
    `Set valutato: ${report.dataset.scored_count} trace, ${report.dataset.categories.length} categorie (${categories}).`,
    "",
    `Provenienza: ${fixtures.length} fixture già nel repository (${fixtureList}) e ${generated} trace del harness scriptato. Rigenerare le trace del harness e il manifest con \`pnpm generate-dataset\` (mock in loopback, driver \`scripted\`, fault del catalogo). Poi \`pnpm eval\` riscrive questa sezione.`,
    "",
    "Il ground truth è l'unica etichetta in `fault.labels`. Se `fault.attacker.used` è true, la fonte nel manifest è `fault.attacker`: quell'oggetto non ha una categoria e ADR-002 attribuisce l'etichetta all'attaccante. Il valutatore legge `fault`. Il prompt di Grok no.",
    "",
    "### Definizioni",
    ...definitions,
    "",
    "La baseline solo-regole prende il primo finding di `diagnosisFindings`, in quest'ordine. Senza finding il metodo si astiene.",
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
    `- Hint dell'iniettore in ${hints}/${scored} trace. I marker negli step (\`Injected execution drop…\`, \`Injector skipped\`, \`forged: true\`, \`stale: true\`, \`injected: true\`) arrivano a Grok. Follow-up del backend (@diamanti-sg). Questo eval non modifica \`apps/backend\`.`,
    "- Il driver scriptato dà poca varietà finché non entra l'agent di riferimento ([PR #21](https://github.com/mesagroup/MESA-AgentFailureLab/pull/21)). `pnpm generate-dataset` non copia quell'agent.",
    "- L'efficacia del fix richiede il replay del verificatore ([#15](https://github.com/mesagroup/MESA-AgentFailureLab/issues/15)). La riga del fix nella tabella dice solo se la proposta contiene il fix ADR-002 della categoria etichettata.",
    `- Una sola passata (conteggio: ${MEASUREMENT.passes}). ADR-001 esclude l'aggregazione multi-run.`,
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
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    ["Accuratezza di categoria", fraction(baseline.category_correct, baseline.scored), grokFraction(report, "category_correct", "scored")],
    ["Step esatto", fraction(baseline.step_exact, baseline.scored), grokFraction(report, "step_exact", "scored")],
    ["Step entro ±1", fraction(baseline.step_tolerance_1, baseline.scored), grokFraction(report, "step_tolerance_1", "scored")],
    ["Hit del fix proposto", fraction(baseline.fix_hits, baseline.fix_applicable), grokFraction(report, "fix_hits", "fix_applicable")],
    ["Fix non applicabile", String(baseline.fix_not_applicable), grokCount(report, "fix_not_applicable")],
    ["Latenza media (ms)", formatMs(baseline.mean_latency_ms), grokLatency(report)],
    ["Token in/out", formatTokens(baseline), grokTokens(report)],
    ["Costo USD", formatCost(baseline.cost_usd.total), grokCost(report)],
  ];
  const lines = ["| Metrica | Baseline (solo regole) | Grok |", "| --- | --- | --- |"];
  for (const [metric, rules, model] of rows) {
    lines.push(`| ${metric} | ${rules} | ${model} |`);
  }
  return lines.join("\n");
}

function grokBanner(report: EvalReport): string {
  const grok = report.methods.grok;
  if (grok.mode === "skipped") {
    return "> **Colonna Grok — segnaposto.** Non è un risultato. Si riempie eseguendo `pnpm eval` con `XAI_API_KEY` impostata.";
  }
  if (grok.mode === "fake") {
    return "> **Colonna Grok — fake.** Non è un punteggio di Grok. Il modello etichettato è `fake-diagnosis`.";
  }
  const name = grok.model ?? "unnamed";
  return `> **Colonna Grok — live** (\`${name}\`), una passata. Errori nel denominatore: ${grok.errors}.`;
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
    return "Senza `XAI_API_KEY` il costo di Grok è n/a. La baseline solo-regole non riporta token né costo.";
  }
  if (grok.mode === "fake") {
    return "La colonna Grok di questa esecuzione è un fake: il costo non è un costo xAI. La baseline solo-regole non riporta token né costo.";
  }
  return `Costo Grok riportato dal provider: ${formatCost(grok.cost_usd.total)} USD (totale), token in/out ${formatTokens(grok)}. La baseline solo-regole non riporta token né costo.`;
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
