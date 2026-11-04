import { planLibraryTask, planShopTask, type AgentTask } from "@mesa/shared";

export interface PlannedAction {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/**
 * Permissions the scripted driver is granted for a task. This is not authentication.
 * `setup.permissions` is the task's grant. `grantCancel: false` withholds
 * `write:order:cancel` for the security attacker without editing the task.
 */
export function permissionsFor(task: AgentTask, grantCancel: boolean): string[] {
  const granted = [...task.setup.permissions];
  if (grantCancel) return granted;
  return granted.filter((permission) => permission !== "write:order:cancel");
}

/**
 * Deterministic tool sequence taken from the task document.
 * This planner does not read `fix_kinds`. `controlled_retry` is applied later in
 * `executeAttempt`. `pre_response_check` and `permission_guard` are agent-side:
 * an HTTP agent sees them on `AgentRunRequest`.
 */
export function scriptedActions(
  task: AgentTask,
  ctx: { orderId?: string; permissions: readonly string[] },
): PlannedAction[] {
  const planned = task.setup.library ? planLibraryTask(task, ctx) : planShopTask(task, ctx);
  if (!planned.ok) throw new Error(planned.message);
  return planned.actions;
}
