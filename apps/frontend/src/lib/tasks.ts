import {
  CHECK_REGISTRY,
  isCheckType,
  type AgentTask,
  type AgentTaskCheck,
  type CheckParamField,
  type CheckType,
} from "@mesa/shared";

export interface CartLineError {
  sku?: string;
  qty?: string;
}

export interface CheckFieldError {
  description?: string;
  params: Record<string, string>;
}

export interface TaskFieldError {
  task_id?: string;
  title?: string;
  prompt?: string;
  cart: Record<number, CartLineError>;
  checks: Record<number, CheckFieldError>;
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

export function taskFieldErrors(tasks: AgentTask[]): TaskFieldError[] {
  const seen = new Map<string, number>();
  return tasks.map((task, index) => {
    const error: TaskFieldError = { cart: {}, checks: {} };
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
    return error;
  });
}

export function tasksHaveErrors(errors: TaskFieldError[]): boolean {
  return errors.some(
    (error) =>
      Boolean(error.task_id || error.title || error.prompt) ||
      Object.keys(error.cart).length > 0 ||
      Object.keys(error.checks).length > 0,
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
