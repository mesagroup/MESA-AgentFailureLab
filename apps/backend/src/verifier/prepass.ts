import type { TraceStep, TraceStatus } from "@mesa/shared";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_REPEAT_THRESHOLD = 3;

export interface PrePassFinding {
  kind: "loop" | "timeout" | "repeated_tool";
  detail: string;
  step_id?: string;
}

export interface PrePassInput {
  started_at: string;
  ended_at: string;
  status?: TraceStatus;
  steps: readonly Pick<TraceStep, "step_id" | "type" | "tool_name" | "tool_input" | "latency_ms">[];
  timeoutMs?: number;
  repeatThreshold?: number;
}

/**
 * Cheap structural pass over a trace. It does not write `outcome.verifier`.
 * Findings are signals for the harness (and later for Grok). They are not a verdict.
 */
export function prePass(input: PrePassInput): PrePassFinding[] {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const repeatThreshold = input.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
  const findings: PrePassFinding[] = [];

  const started = Date.parse(input.started_at);
  const ended = Date.parse(input.ended_at);
  const wall = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : 0;
  const latency = input.steps.reduce((sum, step) => sum + step.latency_ms, 0);
  if (input.status === "timeout" || wall >= timeoutMs || latency >= timeoutMs) {
    findings.push({
      kind: "timeout",
      detail: `Elapsed ${Math.max(wall, latency)} ms reached the ${timeoutMs} ms limit.`,
    });
  }

  const calls = input.steps.filter((step) => step.type === "tool_call" && step.tool_name);
  const counts = new Map<string, { count: number; step_id: string }>();
  for (const call of calls) {
    const name = call.tool_name ?? "";
    const current = counts.get(name);
    if (current) {
      current.count += 1;
    } else {
      counts.set(name, { count: 1, step_id: call.step_id });
    }
  }
  for (const [name, info] of counts) {
    if (info.count >= repeatThreshold) {
      findings.push({
        kind: "repeated_tool",
        detail: `${name} was called ${info.count} times.`,
        step_id: info.step_id,
      });
    }
  }

  let previous = "";
  let streak = 0;
  let streakStep = "";
  for (const call of calls) {
    const signature = `${call.tool_name ?? ""}:${JSON.stringify(call.tool_input ?? null)}`;
    if (signature === previous) {
      streak += 1;
    } else {
      previous = signature;
      streak = 1;
      streakStep = call.step_id;
    }
    if (streak === repeatThreshold) {
      findings.push({
        kind: "loop",
        detail: `${call.tool_name ?? "tool"} repeated ${streak} times with the same input.`,
        step_id: streakStep,
      });
    }
  }

  return findings;
}
