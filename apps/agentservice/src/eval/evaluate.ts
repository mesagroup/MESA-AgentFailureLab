import { FAULT_CATEGORIES, type FaultCategory, type FixKind } from "@mesa/shared";
import { DiagnosisFailed, diagnoseTrace, type DiagnosisModel, type ModelUsage } from "../diagnosis/diagnose.js";
import { loadDataset, type LoadedCase } from "./load-dataset.js";
import {
  LEAKAGE_NOTE,
  emptyCategoryCounts,
  fixTarget,
  rulesBaseline,
  type HintId,
  type RulesPrediction,
  type ScoredTruth,
} from "./rules.js";

export const METRIC_DEFINITIONS = {
  category_accuracy:
    "Predicted category equals the single fault.labels category. Abstain and a failed diagnosis are misses. The denominator is every scored trace.",
  step_accuracy_exact: "Predicted step_id equals the labelled step_id.",
  step_accuracy_tolerance_1:
    "Absolute difference of step.index between the prediction and the labelled step is at most 1, including an exact match. A predicted step_id that is not on the trace is a miss.",
  proposed_fix_hit_rate:
    "The ADR-002 fix for the labelled category appears in proposed_fixes. Execution → controlled_retry, Verification → pre_response_check, Security → permission_guard. Plan, ToolUse, Context, and Reasoning have no MVP fix and are excluded. Extra proposed fixes do not cancel a hit. This is a proposal match, not a verifier replay.",
  mean_latency_ms:
    "Arithmetic mean of one pass over the scored traces. The timer wraps rulesBaseline or diagnoseTrace after the trace is already loaded. This is a description of that pass, not a tuned benchmark and not a median of repeated trials.",
  tokens_and_cost:
    "Input and output tokens and cost_usd are whatever the provider reported. Missing usage stays null. Token counts are not converted into a price. Failed diagnoses still add tokens when the provider returned usage before the response was rejected.",
} as const;

export const MEASUREMENT = {
  passes: 1,
  timed_region: "rulesBaseline or diagnoseTrace, after the trace is loaded",
  baseline_limiter:
    "One synchronous walk of the trace steps inside diagnosisFindings. The timer contains no model call and no disk read.",
  grok_limiter: "The xAI chat completion when XAI_API_KEY is set. With no key the method is skipped and has no latency.",
  cost_policy: METRIC_DEFINITIONS.tokens_and_cost,
  errors_policy: "A failed diagnosis stays in the denominator and counts as a miss for category, step, and an applicable fix.",
} as const;

export type Scoreable =
  | {
      kind: "prediction";
      category: FaultCategory;
      step_id: string;
      proposed_fixes: readonly FixKind[];
    }
  | { kind: "abstain"; reason: "no_findings" }
  | { kind: "error"; reason: "diagnosis_failed" };

export type ModelPrediction = Exclude<Scoreable, { kind: "abstain" }>;

export interface Judgement<P extends Scoreable> {
  prediction: P;
  latency_ms: number;
  usage: ModelUsage | null;
  category_match: boolean;
  step_exact: boolean;
  step_tolerance_1: boolean;
  /** `null` when the labelled category has no ADR-002 fix. */
  fix_hit: boolean | null;
}

export interface EvalCase {
  id: string;
  origin: LoadedCase["origin"];
  relative_path: string;
  truth: ScoredTruth;
  hints: readonly HintId[];
  baseline: Judgement<RulesPrediction>;
  grok: Judgement<ModelPrediction> | null;
}

export type ConfusionColumn = FaultCategory | "abstain" | "error";

export type ConfusionMatrix = Record<FaultCategory, Record<ConfusionColumn, number>>;

export interface MethodSummary {
  mode: "rules" | "live" | "fake";
  model: string | null;
  live: boolean;
  passes: 1;
  scored: number;
  errors: number;
  category_correct: number;
  step_exact: number;
  step_tolerance_1: number;
  fix_hits: number;
  fix_applicable: number;
  fix_not_applicable: number;
  mean_latency_ms: number;
  tokens: {
    input: number | null;
    output: number | null;
    traces_with_usage: number;
  };
  cost_usd: {
    total: number | null;
    mean: number | null;
    traces_with_cost: number;
  };
  confusion: ConfusionMatrix;
}

export interface EvalReport {
  schema_version: 1;
  generated_at: string;
  definitions: typeof METRIC_DEFINITIONS;
  measurement: typeof MEASUREMENT;
  dataset: {
    scored_count: number;
    categories: FaultCategory[];
    category_counts: Record<FaultCategory, number>;
    leakage: {
      traces_with_hints: number;
      by_hint: Record<HintId, number>;
      note: string;
    };
  };
  methods: {
    baseline: MethodSummary;
    grok: MethodSummary | { mode: "skipped"; reason: string };
  };
  cases: EvalCase[];
}

export type GrokRun =
  | { mode: "skipped"; reason: string }
  | { mode: "fake"; model: DiagnosisModel; modelName: string }
  | { mode: "live"; model: DiagnosisModel; modelName: string };

export const FAKE_MODEL_NAME = "fake-diagnosis";

export async function evaluateDataset(input: {
  repoRoot: string;
  manifestPath: string;
  grok: GrokRun;
  generatedAt?: string;
}): Promise<EvalReport> {
  const loaded = loadDataset(input.repoRoot, input.manifestPath);
  const cases: EvalCase[] = [];
  for (const item of loaded) {
    cases.push(await judgeCase(item, input.grok));
  }
  return buildReport({
    cases,
    grok: input.grok,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  });
}

export function buildReport(input: { cases: readonly EvalCase[]; grok: GrokRun; generatedAt: string }): EvalReport {
  const categoryCounts = emptyCategoryCounts();
  const byHint = emptyHintCounts();
  let tracesWithHints = 0;
  for (const item of input.cases) {
    categoryCounts[item.truth.category] += 1;
    if (item.hints.length > 0) {
      tracesWithHints += 1;
    }
    for (const hint of item.hints) {
      byHint[hint] += 1;
    }
  }
  const categories = FAULT_CATEGORIES.filter((category) => categoryCounts[category] > 0);
  const baseline = summarize(
    input.cases.map((item) => ({ category: item.truth.category, judgement: widen(item.baseline) })),
    "rules",
    null,
    false,
  );
  const grok = summarizeGrok(input.cases, input.grok);
  return {
    schema_version: 1,
    generated_at: input.generatedAt,
    definitions: METRIC_DEFINITIONS,
    measurement: MEASUREMENT,
    dataset: {
      scored_count: input.cases.length,
      categories: [...categories],
      category_counts: categoryCounts,
      leakage: {
        traces_with_hints: tracesWithHints,
        by_hint: byHint,
        note: LEAKAGE_NOTE,
      },
    },
    methods: { baseline, grok },
    cases: [...input.cases],
  };
}

export function scoreJudgement(trace: LoadedCase["trace"], truth: ScoredTruth, prediction: Scoreable): Omit<
  Judgement<Scoreable>,
  "prediction" | "latency_ms" | "usage"
> {
  const categoryMatch = prediction.kind === "prediction" && prediction.category === truth.category;
  const stepExact = prediction.kind === "prediction" && prediction.step_id === truth.step_id;
  const distance = prediction.kind === "prediction" ? stepDistance(trace, prediction.step_id, truth.step_id) : null;
  const target = fixTarget(truth.category);
  const fixHit =
    target === null
      ? null
      : prediction.kind === "prediction" && prediction.proposed_fixes.includes(target);
  return {
    category_match: categoryMatch,
    step_exact: stepExact,
    step_tolerance_1: distance !== null && distance <= 1,
    fix_hit: fixHit,
  };
}

export function fakeDiagnosisModel(): DiagnosisModel {
  return {
    async complete(request) {
      const stepId = firstStepId(request.user);
      return {
        content: JSON.stringify({
          category: "Plan",
          cause: "Fake diagnosis used when no model is configured. This is not a Grok result.",
          step_id: stepId,
          confidence: 0.1,
          evidence: [`${stepId} fake diagnosis`],
          proposed_fixes: [],
        }),
        usage: { input_tokens: 1, output_tokens: 1, cost_usd: null },
      };
    },
  };
}

async function judgeCase(item: LoadedCase, grok: GrokRun): Promise<EvalCase> {
  const baselineStarted = performance.now();
  const baselinePrediction = rulesBaseline(item.trace);
  const baselineLatency = roundMs(performance.now() - baselineStarted);
  const baselineScore = scoreJudgement(item.trace, item.truth, baselinePrediction);
  const modelJudgement = grok.mode === "skipped" ? null : await judgeModel(item, grok);
  return {
    id: item.id,
    origin: item.origin,
    relative_path: item.relative_path,
    truth: item.truth,
    hints: item.hints,
    baseline: {
      prediction: baselinePrediction,
      latency_ms: baselineLatency,
      usage: null,
      ...baselineScore,
    },
    grok: modelJudgement,
  };
}

async function judgeModel(
  item: LoadedCase,
  grok: Exclude<GrokRun, { mode: "skipped" }>,
): Promise<Judgement<ModelPrediction>> {
  const input = { ...item.trace, diagnosis: null };
  let usage: ModelUsage | null = null;
  const started = performance.now();
  try {
    const diagnosed = await diagnoseTrace(input, {
      model: grok.model,
      modelName: grok.modelName,
      onUsage(value) {
        usage = value;
      },
    });
    const prediction: ModelPrediction = {
      kind: "prediction",
      category: diagnosed.diagnosis.category,
      step_id: diagnosed.diagnosis.step_id,
      proposed_fixes: diagnosed.diagnosis.proposed_fixes,
    };
    return {
      prediction,
      latency_ms: roundMs(performance.now() - started),
      usage,
      ...scoreJudgement(item.trace, item.truth, prediction),
    };
  } catch (error) {
    if (!(error instanceof DiagnosisFailed)) {
      throw error;
    }
    const prediction: ModelPrediction = { kind: "error", reason: "diagnosis_failed" };
    return {
      prediction,
      latency_ms: roundMs(performance.now() - started),
      usage,
      ...scoreJudgement(item.trace, item.truth, prediction),
    };
  }
}

interface TaggedJudgement {
  category: FaultCategory;
  judgement: Judgement<Scoreable>;
}

function widen<P extends Scoreable>(judgement: Judgement<P>): Judgement<Scoreable> {
  return { ...judgement, prediction: toScoreable(judgement.prediction) };
}

function toScoreable(prediction: Scoreable): Scoreable {
  if (prediction.kind !== "prediction") {
    return prediction;
  }
  return {
    kind: "prediction",
    category: prediction.category,
    step_id: prediction.step_id,
    proposed_fixes: prediction.proposed_fixes,
  };
}

function summarize(
  items: readonly TaggedJudgement[],
  mode: MethodSummary["mode"],
  model: string | null,
  live: boolean,
): MethodSummary {
  const scored = items.length;
  let errors = 0;
  let categoryCorrect = 0;
  let stepExact = 0;
  let stepTolerance = 0;
  let fixHits = 0;
  let fixApplicable = 0;
  let fixNotApplicable = 0;
  let latencyTotal = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let tracesWithUsage = 0;
  let costTotal = 0;
  let tracesWithCost = 0;
  const confusion = emptyConfusion();
  for (const item of items) {
    const judgement = item.judgement;
    if (judgement.prediction.kind === "error") {
      errors += 1;
    }
    if (judgement.category_match) {
      categoryCorrect += 1;
    }
    if (judgement.step_exact) {
      stepExact += 1;
    }
    if (judgement.step_tolerance_1) {
      stepTolerance += 1;
    }
    if (judgement.fix_hit === null) {
      fixNotApplicable += 1;
    } else {
      fixApplicable += 1;
      if (judgement.fix_hit) {
        fixHits += 1;
      }
    }
    latencyTotal += judgement.latency_ms;
    if (judgement.usage !== null) {
      inputTokens += judgement.usage.input_tokens;
      outputTokens += judgement.usage.output_tokens;
      tracesWithUsage += 1;
      if (judgement.usage.cost_usd !== null) {
        costTotal += judgement.usage.cost_usd;
        tracesWithCost += 1;
      }
    }
    const column = confusionColumn(judgement.prediction);
    confusion[item.category][column] += 1;
  }
  if (fixApplicable + fixNotApplicable !== scored) {
    throw new Error("Fix applicability does not partition the scored traces.");
  }
  assertConfusion(confusion, items);
  return {
    mode,
    model,
    live,
    passes: 1,
    scored,
    errors,
    category_correct: categoryCorrect,
    step_exact: stepExact,
    step_tolerance_1: stepTolerance,
    fix_hits: fixHits,
    fix_applicable: fixApplicable,
    fix_not_applicable: fixNotApplicable,
    mean_latency_ms: scored === 0 ? 0 : roundMs(latencyTotal / scored),
    tokens: {
      input: tracesWithUsage === 0 ? null : inputTokens,
      output: tracesWithUsage === 0 ? null : outputTokens,
      traces_with_usage: tracesWithUsage,
    },
    cost_usd: {
      total: tracesWithCost === 0 ? null : costTotal,
      mean: tracesWithCost === 0 ? null : costTotal / tracesWithCost,
      traces_with_cost: tracesWithCost,
    },
    confusion,
  };
}

function summarizeGrok(cases: readonly EvalCase[], grok: GrokRun): EvalReport["methods"]["grok"] {
  if (grok.mode === "skipped") {
    return { mode: "skipped", reason: grok.reason };
  }
  const items: TaggedJudgement[] = [];
  for (const item of cases) {
    if (item.grok === null) {
      throw new Error(`Grok ran but ${item.id} has no model judgement.`);
    }
    items.push({ category: item.truth.category, judgement: widen(item.grok) });
  }
  return summarize(items, grok.mode, grok.modelName, grok.mode === "live");
}

function confusionColumn(prediction: Scoreable): ConfusionColumn {
  switch (prediction.kind) {
    case "prediction":
      return prediction.category;
    case "abstain":
      return "abstain";
    case "error":
      return "error";
    default: {
      const exhaustive: never = prediction;
      return exhaustive;
    }
  }
}

function emptyConfusion(): ConfusionMatrix {
  return {
    Plan: zeroConfusionRow(),
    ToolUse: zeroConfusionRow(),
    Context: zeroConfusionRow(),
    Reasoning: zeroConfusionRow(),
    Execution: zeroConfusionRow(),
    Verification: zeroConfusionRow(),
    Security: zeroConfusionRow(),
  };
}

function zeroConfusionRow(): Record<ConfusionColumn, number> {
  return {
    Plan: 0,
    ToolUse: 0,
    Context: 0,
    Reasoning: 0,
    Execution: 0,
    Verification: 0,
    Security: 0,
    abstain: 0,
    error: 0,
  };
}

function assertConfusion(confusion: ConfusionMatrix, items: readonly TaggedJudgement[]): void {
  const counts = emptyCategoryCounts();
  for (const item of items) {
    counts[item.category] += 1;
  }
  for (const category of FAULT_CATEGORIES) {
    const row = confusion[category];
    const sum =
      row.Plan +
      row.ToolUse +
      row.Context +
      row.Reasoning +
      row.Execution +
      row.Verification +
      row.Security +
      row.abstain +
      row.error;
    if (sum !== counts[category]) {
      throw new Error(`Confusion row ${category} sums to ${sum}, scored ${counts[category]}.`);
    }
  }
}

function emptyHintCounts(): Record<HintId, number> {
  return {
    dropped_message: 0,
    injector_skipped: 0,
    injector_missed_target: 0,
    forged_true: 0,
    stale_true: 0,
    injected_true: 0,
  };
}

function stepDistance(trace: LoadedCase["trace"], predicted: string, expected: string): number | null {
  const predictedIndex = indexOfStep(trace, predicted);
  const expectedIndex = indexOfStep(trace, expected);
  if (predictedIndex === null || expectedIndex === null) {
    return null;
  }
  return Math.abs(predictedIndex - expectedIndex);
}

function indexOfStep(trace: LoadedCase["trace"], stepId: string): number | null {
  const step = trace.steps.find((item) => item.step_id === stepId);
  if (step === undefined) {
    return null;
  }
  return step.index;
}

function firstStepId(user: string): string {
  const parsed: unknown = JSON.parse(user);
  if (!isRecord(parsed) || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    return "missing-step";
  }
  const first = parsed.steps[0];
  if (!isRecord(first) || typeof first.step_id !== "string" || first.step_id.length === 0) {
    return "missing-step";
  }
  return first.step_id;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
