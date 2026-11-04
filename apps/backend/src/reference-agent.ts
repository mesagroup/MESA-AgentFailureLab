import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Agent, AgentTask } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";

/** Reference shop fixture shipped with `@mesa/shared`. Tasks T1–T5 and their verifier checks. */
export function loadReferenceAgent(): Agent {
  return loadAgentFixture("@mesa/shared/examples/agent-reference-shop.json");
}

/** Library desk fixture. Three loan tasks on the external runtime. */
export function loadLibraryAgent(): Agent {
  return loadAgentFixture("@mesa/shared/examples/agent-library-desk.json");
}

/** Demo agents, in seed order. Each one is inserted or rewritten on its own. */
export function loadSeedAgents(): Agent[] {
  return [loadReferenceAgent(), loadLibraryAgent()];
}

function loadAgentFixture(specifier: string): Agent {
  const url = import.meta.resolve(specifier);
  const parsed: unknown = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
  const result = validateAgent(parsed);
  if (!result.ok) {
    throw new Error(`${specifier} is invalid: ${result.errors.join("; ")}`);
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
