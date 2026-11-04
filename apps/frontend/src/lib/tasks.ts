import {
  CHECK_REGISTRY,
  TASK_EVALSET_VERSION,
  isCheckType,
  type AgentTask,
  type AgentTaskCheck,
  type CheckParamField,
  type CheckType,
  type TaskEvalCase,
} from "@mesa/shared";

export interface CartLineError {
  sku?: string;
  qty?: string;
}

export interface CheckFieldError {
  description?: string;
  params: Record<string, string>;
}

export interface EvalCaseFieldError {
  case_id?: string;
  expectation?: string;
  rubric?: string;
}

export interface TaskFieldError {
  task_id?: string;
  title?: string;
  prompt?: string;
  cart: Record<number, CartLineError>;
  checks: Record<number, CheckFieldError>;
  /** Set when `evalset` is present but `version` is not 1 or `cases` is missing. */
  evalset?: string;
  eval_cases: Record<number, EvalCaseFieldError>;
}

export function blankTasks(): AgentTask[] {
  return [blankTask("task-1")];
}

/** A new task has no shop SKUs, prompts, or seeded permissions. */
export function blankTask(taskId: string): AgentTask {
  return {
    task_id: taskId,
    title: "",
    prompt: "",
    setup: { cart: [], orders: [], permissions: [] },
    success_test: {
      type: "verifier_checks",
      checks: [checkOf("catalog_read")],
    },
  };
}

export function nextTaskId(tasks: AgentTask[]): string {
  const used = new Set(tasks.map((task) => task.task_id));
  let index = tasks.length + 1;
  let id = `task-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `task-${index}`;
  }
  return id;
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

export function taskFieldErrors(tasks: AgentTask[]): TaskFieldError[] {
  const seen = new Map<string, number>();
  return tasks.map((task, index) => {
    const error: TaskFieldError = { cart: {}, checks: {}, eval_cases: {} };
    const id = task.task_id.trim();
    if (!id) error.task_id = "Enter a task id.";
    else if (seen.has(id)) error.task_id = "This task id is already used.";
    else seen.set(id, index);
    if (!task.title.trim()) error.title = "Enter a title.";
    if (!task.prompt.trim()) error.prompt = "Enter the prompt the agent will see.";
    task.setup.cart.forEach((line, lineIndex) => {
      const lineError: CartLineError = {};
      if (!line.sku.trim()) lineError.sku = "Enter a SKU.";
      if (!Number.isInteger(line.qty) || line.qty < 1) lineError.qty = "Quantity must be a whole number of at least 1.";
      if (lineError.sku || lineError.qty) error.cart[lineIndex] = lineError;
    });
    if (task.success_test.checks.length === 0) {
      error.checks[0] = { description: "Add a check.", params: {} };
    }
    task.success_test.checks.forEach((check, checkIndex) => {
      const checkError: CheckFieldError = { params: {} };
      if (!isCheckType(check.name)) checkError.description = "Choose a known check.";
      else if (!check.description.trim()) checkError.description = "Describe what this check means.";
      else {
        const params = check.params ?? {};
        for (const field of CHECK_REGISTRY[check.name].params) {
          const issue = paramIssue(params[field.name], field);
          if (issue) checkError.params[field.name] = issue;
        }
      }
      if (checkError.description || Object.keys(checkError.params).length > 0) error.checks[checkIndex] = checkError;
    });
    const evalsetError = evalsetIssue(task);
    if (evalsetError) error.evalset = evalsetError;
    else if (task.evalset) {
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
        if (caseError.case_id || caseError.expectation || caseError.rubric) error.eval_cases[caseIndex] = caseError;
      });
    }
    return error;
  });
}

function evalsetIssue(task: AgentTask): string | undefined {
  if (!task.evalset) return undefined;
  if (task.evalset.version !== TASK_EVALSET_VERSION) return "Evalset version must be 1.";
  if (!Array.isArray(task.evalset.cases)) return "Evalset cases are required.";
  return undefined;
}

export function tasksHaveErrors(errors: TaskFieldError[]): boolean {
  return errors.some(
    (error) =>
      Boolean(error.task_id || error.title || error.prompt || error.evalset) ||
      Object.keys(error.cart).length > 0 ||
      Object.keys(error.checks).length > 0 ||
      Object.keys(error.eval_cases).length > 0,
  );
}

export function checkOf(name: CheckType): AgentTaskCheck {
  return { name, description: "" };
}

function paramIssue(value: unknown, field: CheckParamField): string | undefined {
  if (value === undefined || value === "") {
    return field.required ? "This field is required." : undefined;
  }
  if (field.type === "string" && (typeof value !== "string" || value.trim().length === 0)) {
    return "Enter text.";
  }
  if (field.type === "integer" && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
    return "Enter a whole number of at least 1.";
  }
  return undefined;
}
