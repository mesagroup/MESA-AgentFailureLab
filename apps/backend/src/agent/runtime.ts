import type { Agent, RunPhase } from "@mesa/shared";
import {
  AGENT_RUNTIME_LABELS,
  type AgentRuntimeLabel,
} from "@mesa/shared";

export const PLANNER_FLAGS = ["JURY_AGENT", "LAB_AGENT", "ATTACKER_AGENT", "FIX_AGENT"] as const;

export type PlannerFlag = (typeof PLANNER_FLAGS)[number];

export type PlannerRole = "jury" | "lab" | "attacker" | "fix";

/**
 * Absent, blank, or any value other than `grok` keeps the scripted planner.
 * The default is off so CI and the offline demo never select Grok.
 */
export function flagRequestsGrok(env: NodeJS.ProcessEnv, flag: PlannerFlag): boolean {
  return env[flag]?.trim() === "grok";
}

export function plannerFlagForRole(role: PlannerRole): PlannerFlag {
  switch (role) {
    case "jury":
      return "JURY_AGENT";
    case "attacker":
      return "ATTACKER_AGENT";
    case "fix":
      return "FIX_AGENT";
    case "lab":
      return "LAB_AGENT";
  }
}

/** Shop runs can use the Grok planner. The library desk keeps its own scripted plan. */
export function agentUsesShopPlanner(agent: Pick<Agent, "world" | "tasks">): boolean {
  if (agent.world?.kind === "library") return false;
  return !agent.tasks.some((task) => task.setup.library !== undefined);
}

export function roleForRun(phase: RunPhase, attackerPayloadId: string | null | undefined): PlannerRole {
  if (attackerPayloadId) return phase === "after_fix" ? "fix" : "attacker";
  if (phase === "after_fix") return "fix";
  return "lab";
}

/**
 * `configured === false` is a missing xAI key: stay scripted and say so.
 * `null` means the probe did not answer. The run still asks for Grok; the
 * agent service falls back if it has no key.
 */
export function runtimeLabel(requested: boolean, configured: boolean | null): AgentRuntimeLabel {
  if (!requested) return AGENT_RUNTIME_LABELS.scripted;
  if (configured === false) return AGENT_RUNTIME_LABELS.noKey;
  return AGENT_RUNTIME_LABELS.grok;
}

export interface AgentRuntimeSnapshot {
  lab: AgentRuntimeLabel;
  jury: AgentRuntimeLabel;
  attacker: AgentRuntimeLabel;
  fix: AgentRuntimeLabel;
}

export function runtimeSnapshot(env: NodeJS.ProcessEnv, configured: boolean | null): AgentRuntimeSnapshot {
  return {
    lab: runtimeLabel(flagRequestsGrok(env, "LAB_AGENT"), configured),
    jury: runtimeLabel(flagRequestsGrok(env, "JURY_AGENT"), configured),
    attacker: runtimeLabel(flagRequestsGrok(env, "ATTACKER_AGENT"), configured),
    fix: runtimeLabel(flagRequestsGrok(env, "FIX_AGENT"), configured),
  };
}

export function anyPlannerRequested(env: NodeJS.ProcessEnv): boolean {
  return PLANNER_FLAGS.some((flag) => flagRequestsGrok(env, flag));
}
