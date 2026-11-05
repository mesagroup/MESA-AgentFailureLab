import { AGENT_RUNTIME_LABELS, agentRuntimeLine, type AgentRuntimeLabel } from "@mesa/shared";
import type { LaunchPhase } from "./run-launch";
import type { AgentRuntimeSnapshot } from "./api";

export function agentRuntimeLabelFromTrace(trace: { steps: readonly { content?: string }[] }): AgentRuntimeLabel {
  const blob = trace.steps.map((step) => step.content ?? "").join("\n");
  if (blob.includes(agentRuntimeLine(AGENT_RUNTIME_LABELS.noKey))) return AGENT_RUNTIME_LABELS.noKey;
  if (blob.includes(agentRuntimeLine(AGENT_RUNTIME_LABELS.grok))) return AGENT_RUNTIME_LABELS.grok;
  return AGENT_RUNTIME_LABELS.scripted;
}

export function launchAgentLabel(
  runtimes: AgentRuntimeSnapshot | null,
  phase: LaunchPhase,
): AgentRuntimeLabel {
  if (!runtimes) return AGENT_RUNTIME_LABELS.scripted;
  if (phase === "jury") return runtimes.jury;
  if (phase === "after_fix") return runtimes.fix;
  return runtimes.lab;
}
