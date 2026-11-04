import type { FaultCategory, FixKind, Trace, TraceStep } from "@mesa/shared";
import {
  DIAGNOSIS_FINDING_PRIORITY,
  diagnosisFindings,
  type DiagnosisFindingKind,
} from "../diagnosis/diagnose.js";

export const GROUND_TRUTH_SOURCES = ["fault.labels", "fault.attacker"] as const;
export type GroundTruthSource = (typeof GROUND_TRUTH_SOURCES)[number];

/**
 * ADR-002 fix for a labelled category.
 * `null` means the category has no MVP fix (`loop` / `repeated_tool` are in
 * that group, and so are Plan, ToolUse, Context, and Reasoning).
 */
export const FIX_TARGET_BY_CATEGORY = {
  Plan: null,
  ToolUse: null,
  Context: null,
  Reasoning: null,
  Execution: "controlled_retry",
  Verification: "pre_response_check",
  Security: "permission_guard",
} as const satisfies Record<FaultCategory, FixKind | null>;

/**
 * Rules baseline. The first `diagnosisFindings` hit is the whole prediction.
 * No finding → abstain. Proposed fixes are the ADR-002 target for the
 * predicted category, except `repeated_tool_call`, which ADR-002 leaves
 * without an MVP fix.
 */
const BASELINE_BY_FINDING = {
  false_success_claim: { category: "Verification", proposed_fixes: ["pre_response_check"] },
  tool_error: { category: "Execution", proposed_fixes: ["controlled_retry"] },
  repeated_tool_call: { category: "Reasoning", proposed_fixes: [] },
  timeout: { category: "Execution", proposed_fixes: ["controlled_retry"] },
} as const satisfies Record<
  DiagnosisFindingKind,
  { category: FaultCategory; proposed_fixes: readonly FixKind[] }
>;

export type RulesPrediction =
  | {
      kind: "prediction";
      category: FaultCategory;
      step_id: string;
      proposed_fixes: readonly FixKind[];
      finding: DiagnosisFindingKind;
    }
  | { kind: "abstain"; reason: "no_findings" };

export interface ScoredTruth {
  source: GroundTruthSource;
  category: FaultCategory;
  step_id: string;
  code: string;
  attacker_used: boolean;
  payload_id: string | null;
}

export type GroundTruthRead =
  | { ok: true; truth: ScoredTruth }
  | { ok: false; reason: "no_labels" | "ambiguous_labels" };

/**
 * Markers PR #28 writes into steps. `diagnoseTrace` does not strip them, so
 * they reach Grok. Scanning is limited to `trace.steps` (the evaluator's
 * leakage flag), never to `fault`, which the model is not shown.
 */
export const HINT_IDS = [
  "dropped_message",
  "injector_skipped",
  "injector_missed_target",
  "forged_true",
  "stale_true",
  "injected_true",
] as const;

export type HintId = (typeof HINT_IDS)[number];

export const LEAKAGE_NOTE =
  "PR #28 writes fault markers into trace steps that POST /diagnose forwards to Grok. The markers are the tool-result message \"Injected execution drop before the mock was called.\", system text \"Injector skipped\" and \"Injector target … was not called.\", and JSON booleans forged: true, stale: true, and injected: true from apps/backend/src/injector/catalog.ts and apps/backend/src/harness/execute.ts. diagnosisFindings does not strip them. A model can read the marker and name the planted fault, which raises its score above what the same trace would earn without the marker. The jury system step that names attacker.payload_id is a separate string: diagnoseTrace drops any step that contains a label code or that payload id. Follow-up for @diamanti-sg: keep the injected effect, and stop copying these markers into steps the model sees. This eval does not change apps/backend.";

const DROPPED_MESSAGE = "Injected execution drop before the mock was called.";
const SKIPPED_PREFIX = "Injector skipped ";
const MISSED_TARGET_PREFIX = "Injector target ";
const MISSED_TARGET_SUFFIX = "was not called.";

export function rulesBaseline(trace: Trace): RulesPrediction {
  const primary = diagnosisFindings(trace)[0];
  if (primary === undefined) {
    return { kind: "abstain", reason: "no_findings" };
  }
  const mapped = BASELINE_BY_FINDING[primary.kind];
  return {
    kind: "prediction",
    category: mapped.category,
    step_id: primary.step_ids[0],
    proposed_fixes: [...mapped.proposed_fixes],
    finding: primary.kind,
  };
}

export function baselineMappingLines(): string[] {
  return DIAGNOSIS_FINDING_PRIORITY.map((kind) => {
    const row = BASELINE_BY_FINDING[kind];
    const fixes = row.proposed_fixes.length === 0 ? "(none)" : row.proposed_fixes.join(", ");
    return `${kind} → ${row.category} / ${fixes}`;
  });
}

/**
 * Category and step come from the single `fault.labels` entry.
 * `fault.attacker` has no category field. When `attacker.used` is true the
 * source is `fault.attacker` because that writer owns the label (ADR-002).
 * The evaluator calls this. The model path does not.
 */
export function readGroundTruth(trace: Trace): GroundTruthRead {
  if (trace.fault.labels.length === 0) {
    return { ok: false, reason: "no_labels" };
  }
  if (trace.fault.labels.length !== 1) {
    return { ok: false, reason: "ambiguous_labels" };
  }
  const label = trace.fault.labels[0];
  if (label === undefined) {
    return { ok: false, reason: "no_labels" };
  }
  const source: GroundTruthSource = trace.fault.attacker.used ? "fault.attacker" : "fault.labels";
  return {
    ok: true,
    truth: {
      source,
      category: label.category,
      step_id: label.step_id,
      code: label.code,
      attacker_used: trace.fault.attacker.used,
      payload_id: trace.fault.attacker.payload_id,
    },
  };
}

export function hintsInSteps(steps: readonly TraceStep[]): HintId[] {
  const found = new Set<HintId>();
  const blob = JSON.stringify(steps);
  if (blob.includes(DROPPED_MESSAGE)) {
    found.add("dropped_message");
  }
  if (blob.includes(SKIPPED_PREFIX)) {
    found.add("injector_skipped");
  }
  if (blob.includes(MISSED_TARGET_PREFIX) && blob.includes(MISSED_TARGET_SUFFIX)) {
    found.add("injector_missed_target");
  }
  walkFlags(steps, found);
  return HINT_IDS.filter((id) => found.has(id));
}

export function fixTarget(category: FaultCategory): FixKind | null {
  return FIX_TARGET_BY_CATEGORY[category];
}

export function emptyCategoryCounts(): Record<FaultCategory, number> {
  return {
    Plan: 0,
    ToolUse: 0,
    Context: 0,
    Reasoning: 0,
    Execution: 0,
    Verification: 0,
    Security: 0,
  } satisfies Record<FaultCategory, number>;
}

function walkFlags(value: unknown, found: Set<HintId>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkFlags(item, found);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (value.forged === true) {
    found.add("forged_true");
  }
  if (value.stale === true) {
    found.add("stale_true");
  }
  if (value.injected === true) {
    found.add("injected_true");
  }
  for (const child of Object.values(value)) {
    walkFlags(child, found);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
