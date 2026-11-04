import type { TaskEvalset, Trace } from "@mesa/shared";
import type { AgentStore } from "../agents/store.js";

/**
 * The evalset for this trace's task, or `undefined` when there is nothing to pass.
 * Lookup is `trace.agent_id` then the task with the same `task_id`.
 * A missing agent, a missing task, or a task that omits `evalset` all mean
 * the diagnose call stays the stored trace alone.
 */
export async function resolveTaskEvalset(
  agents: AgentStore,
  trace: Pick<Trace, "agent_id" | "task_id">,
): Promise<TaskEvalset | undefined> {
  const agent = await agents.get(trace.agent_id);
  const evalset = agent?.tasks.find((task) => task.task_id === trace.task_id)?.evalset;
  if (evalset === undefined) return undefined;
  return structuredClone(evalset);
}
