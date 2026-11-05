import type { Agent, Run } from "@mesa/shared";
import type { RunTraceLink } from "@/lib/api";

export const DASHBOARD_DESTINATIONS = [
  { to: "/runs?type=security", title: "Security", detail: "Attacker · permission guard" },
  { to: "/agents", title: "Agents", detail: "Registered agents" },
  { to: "/runs", title: "Runs", detail: "Test history" },
  { to: "/traces", title: "Traces", detail: "Inspect traces" },
] as const;

/**
 * A run with a stored trace opens that trace.
 * `first_trace_id` is the id to open. A run id is never placed under `/traces`.
 * When `first_trace_id` is null, the row opens `/runs/:runId`.
 */
export function dashboardRunHref(run: Pick<Run, "run_id">, link: Pick<RunTraceLink, "first_trace_id"> | undefined): string {
  if (link?.first_trace_id) return `/traces/${encodeURIComponent(link.first_trace_id)}`;
  return `/runs/${encodeURIComponent(run.run_id)}`;
}

export function linkFor(links: readonly RunTraceLink[], run: Pick<Run, "run_id">, index: number): RunTraceLink | undefined {
  const aligned = links[index];
  if (aligned?.run_id === run.run_id) return aligned;
  return links.find((item) => item.run_id === run.run_id);
}

/** The seeded shop assistant is the demo world, not the product. */
export function isShoppingDemo(agent: Pick<Agent, "agent_id" | "name" | "description">): boolean {
  if (agent.agent_id === "reference-shop") return true;
  const text = `${agent.name} ${agent.description}`.toLowerCase();
  return text.includes("shopping") || text.includes("e-commerce") || text.includes("mock shop");
}
