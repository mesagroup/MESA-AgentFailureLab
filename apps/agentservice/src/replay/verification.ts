/** Evidence only. No labels, model confidence or agent claims enter this decision. */
export interface FixEvidence {
  baseline: boolean | null;
  before: boolean | null;
  after: boolean | null;
  expectedControls: readonly string[];
  controls: readonly { taskId: string; baseline: boolean | null; treated: boolean | null }[];
}

export interface FixVerdict {
  fix_verified: boolean | null;
  status: "verified" | "not_verified" | "inconclusive";
  regression: boolean;
  regressions_complete: boolean;
  reason: string;
}

export function verifyFix(evidence: FixEvidence): FixVerdict {
  const expected = new Set(evidence.expectedControls);
  const ids = evidence.controls.map(control => control.taskId);
  const complete = expected.size > 0 && expected.size === evidence.expectedControls.length &&
    ids.length === expected.size && new Set(ids).size === ids.length &&
    evidence.controls.every(control => expected.has(control.taskId) &&
      typeof control.baseline === "boolean" && typeof control.treated === "boolean");
  const regression = evidence.controls.some(control => control.baseline === true && control.treated === false);
  const result = { regression, regressions_complete: complete };
  if ([evidence.baseline, evidence.before, evidence.after].some(value => typeof value !== "boolean") || !complete) {
    return { ...result, fix_verified: null, status: "inconclusive", reason: "Required arms or clean controls are missing, skipped or in error." };
  }
  if (evidence.controls.some(control => control.baseline !== true)) {
    return { ...result, fix_verified: null, status: "inconclusive", reason: "A clean control baseline did not pass." };
  }
  const verified = evidence.baseline === true && evidence.before === false && evidence.after === true && !regression;
  return { ...result, fix_verified: verified, status: verified ? "verified" : "not_verified",
    reason: verified ? "Clean baseline passes, the same fault fails before and passes after, with no observed clean-control regression."
      : regression ? "The treatment regressed a clean control."
      : evidence.baseline !== true ? "The primary clean baseline did not pass."
      : evidence.before !== false ? "The injected attempt already passed before treatment."
      : "The injected replay did not pass after treatment." };
}
