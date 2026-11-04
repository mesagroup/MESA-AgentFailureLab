import type { AgentTask } from "./types.js";
import type { ShopPlanAction, ShopPlanResult } from "./shop-plan.js";

/**
 * Base tool list for the library desk agent, read from the task document.
 * Checks name the goal. `setup.library` is the loan the harness already created.
 * A pattern this agent does not know is `ok: false`. Shop checks are refused.
 */
export function planLibraryTask(
  task: AgentTask,
  _ctx: { permissions: readonly string[] },
): ShopPlanResult {
  if (sameSet(task, ["loan_renewed"])) return planRenew(task);
  if (sameSet(task, ["loan_returned"])) return planReturn(task);
  if (sameSet(task, ["hold_placed"])) return planHold(task);
  const names = task.success_test.checks.map((check) => check.name).join(", ");
  return {
    ok: false,
    message: `This agent cannot plan task ${task.task_id}. It does not know how to satisfy checks: ${names}.`,
  };
}

function planRenew(task: AgentTask): ShopPlanResult {
  const loanId = paramString(task, "loan_renewed", "loan_id");
  if (!loanId) return refuse(task.task_id, "loan_renewed requires params.loan_id.");
  return ok([
    { tool_name: "renew_loan", tool_input: { loan_id: loanId } },
    { tool_name: "get_loan", tool_input: { loan_id: loanId } },
  ]);
}

function planReturn(task: AgentTask): ShopPlanResult {
  const loanId = paramString(task, "loan_returned", "loan_id");
  if (!loanId) return refuse(task.task_id, "loan_returned requires params.loan_id.");
  return ok([
    { tool_name: "return_loan", tool_input: { loan_id: loanId } },
    { tool_name: "get_loan", tool_input: { loan_id: loanId } },
  ]);
}

function planHold(task: AgentTask): ShopPlanResult {
  const bookId = paramString(task, "hold_placed", "book_id");
  const patronId = paramString(task, "hold_placed", "patron_id");
  if (!bookId || !patronId) return refuse(task.task_id, "hold_placed requires params.book_id and params.patron_id.");
  return ok([{ tool_name: "place_hold", tool_input: { book_id: bookId, patron_id: patronId } }]);
}

function sameSet(task: AgentTask, expected: readonly string[]): boolean {
  const got = task.success_test.checks.map((check) => check.name).slice().sort();
  const want = expected.slice().sort();
  return got.length === want.length && got.every((name, index) => name === want[index]);
}

function paramString(task: AgentTask, checkName: string, key: string): string | undefined {
  const check = task.success_test.checks.find((entry) => entry.name === checkName);
  const value = check?.params?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function ok(actions: ShopPlanAction[]): ShopPlanResult {
  return { ok: true, actions };
}

function refuse(taskId: string, message: string): ShopPlanResult {
  return { ok: false, message: `Task ${taskId}: ${message}` };
}
