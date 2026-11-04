import { TASK_EVALSET_VERSION, type AgentTask, type TaskEvalCase } from "@mesa/shared";

export interface EvalCaseFieldError {
  case_id?: string;
  expectation?: string;
  rubric?: string;
}

export interface EvalsetIssues {
  /** Set when `evalset` is present but `version` is not 1 or `cases` is missing. */
  evalset?: string;
  cases: Record<number, EvalCaseFieldError>;
}

export function blankEvalCase(caseId: string): TaskEvalCase {
  return { case_id: caseId, expectation: "" };
}

export function nextCaseId(cases: readonly TaskEvalCase[]): string {
  const used = new Set(cases.map((entry) => entry.case_id));
  let index = cases.length + 1;
  let id = `case-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `case-${index}`;
  }
  return id;
}

/** Append one case and pin `version` to 1. Creates `evalset` when the task has none. */
export function appendEvalCase(task: AgentTask): void {
  const cases = task.evalset?.cases ?? [];
  task.evalset = {
    version: TASK_EVALSET_VERSION,
    cases: [...cases, blankEvalCase(nextCaseId(cases))],
  };
}

/**
 * Drop one case. The last case removes `evalset` so a later PUT omits the field
 * and the stored evalset is dropped.
 */
export function removeEvalCase(task: AgentTask, caseIndex: number): void {
  if (!task.evalset) return;
  const cases = task.evalset.cases.filter((_, index) => index !== caseIndex);
  if (cases.length === 0) delete task.evalset;
  else task.evalset = { version: TASK_EVALSET_VERSION, cases };
}

/** Edit one case. A blank rubric is omitted. `version` is rewritten to 1. */
export function writeEvalCase(
  task: AgentTask,
  caseIndex: number,
  patch: Partial<Pick<TaskEvalCase, "case_id" | "expectation" | "rubric">>,
): void {
  const entry = task.evalset?.cases[caseIndex];
  if (!task.evalset || !entry) return;
  if (patch.case_id !== undefined) entry.case_id = patch.case_id;
  if (patch.expectation !== undefined) entry.expectation = patch.expectation;
  if (patch.rubric !== undefined) {
    if (patch.rubric.trim() === "") delete entry.rubric;
    else entry.rubric = patch.rubric;
  }
  task.evalset.version = TASK_EVALSET_VERSION;
}

/** Field rules for one task's evalset. An omitted evalset has no issues. */
export function evalsetIssues(task: AgentTask): EvalsetIssues {
  if (!task.evalset) return { cases: {} };
  if (task.evalset.version !== TASK_EVALSET_VERSION) {
    return { evalset: "Evalset version must be 1.", cases: {} };
  }
  if (!Array.isArray(task.evalset.cases)) {
    return { evalset: "Evalset cases are required.", cases: {} };
  }
  const cases: Record<number, EvalCaseFieldError> = {};
  const seenCaseIds = new Set<string>();
  task.evalset.cases.forEach((entry, caseIndex) => {
    const caseError: EvalCaseFieldError = {};
    const caseId = entry.case_id.trim();
    if (!caseId) caseError.case_id = "Enter a case id.";
    else if (seenCaseIds.has(entry.case_id)) caseError.case_id = "This case id is already used.";
    else seenCaseIds.add(entry.case_id);
    if (!entry.expectation.trim()) caseError.expectation = "Enter what Grok should look for.";
    if (entry.rubric !== undefined && entry.rubric.trim().length === 0) {
      caseError.rubric = "Enter how to score the expectation, or leave the rubric off.";
    }
    if (caseError.case_id || caseError.expectation || caseError.rubric) cases[caseIndex] = caseError;
  });
  return { cases };
}

/** First evalset problem, for the task editor's single error line. */
export function evalsetErrorMessage(task: AgentTask): string | undefined {
  const issues = evalsetIssues(task);
  if (issues.evalset) return issues.evalset;
  for (const [index, entry] of Object.entries(issues.cases)) {
    const text = entry.case_id ?? entry.expectation ?? entry.rubric;
    if (text) return `Case ${Number(index) + 1}: ${text}`;
  }
  return undefined;
}
