import type { Agent, Run } from "@mesa/shared";
import type { RunTraceLink } from "@/lib/api";

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

/** True when any child run linked from this run has `phase === "after_fix"`. */
function hasAfterFixChild(
  link: RunTraceLink | undefined,
  byId: ReadonlyMap<string, Run>,
): boolean {
  if (!link) return false;
  return link.child_run_ids.some((childId) => byId.get(childId)?.phase === "after_fix");
}

/**
 * Failed/error runs that still need an after_fix replay.
 * Snapshot `runs` are newest-first; filter then cap with `limit`.
 */
export function needsAttentionRuns(
  runs: readonly Run[],
  links: readonly RunTraceLink[],
  limit = 5,
): Array<{ run: Run; link: RunTraceLink | undefined }> {
  const byId = new Map(runs.map((run) => [run.run_id, run]));
  const out: Array<{ run: Run; link: RunTraceLink | undefined }> = [];
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    if (run.status !== "failed" && run.status !== "error") continue;
    const link = linkFor(links, run, index);
    if (hasAfterFixChild(link, byId)) continue;
    out.push({ run, link });
    if (out.length >= limit) break;
  }
  return out;
}

/** The seeded shop assistant is the demo world, not the product. */
export function isShoppingDemo(agent: Pick<Agent, "agent_id" | "name" | "description">): boolean {
  if (agent.agent_id === "reference-shop") return true;
  const text = `${agent.name} ${agent.description}`.toLowerCase();
  return text.includes("shopping") || text.includes("e-commerce") || text.includes("mock shop");
}
