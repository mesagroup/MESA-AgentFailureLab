import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Agent, AgentTask } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";

/** Reference agent fixture shipped with `@mesa/shared`. Tasks T1–T5 and their verifier checks. */
export function loadReferenceAgent(): Agent {
  const url = import.meta.resolve("@mesa/shared/examples/agent-reference-stub.json");
  const parsed: unknown = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
  const result = validateAgent(parsed);
  if (!result.ok) {
    throw new Error(`Reference agent fixture is invalid: ${result.errors.join("; ")}`);
  }
  return result.value;
}

export function taskById(agent: Agent, taskId: string): AgentTask {
  const task = agent.tasks.find((entry) => entry.task_id === taskId);
  if (!task) {
    throw new Error(`Agent ${agent.agent_id} has no task ${taskId}.`);
  }
  return task;
}
