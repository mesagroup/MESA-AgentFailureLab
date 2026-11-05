import type { Run } from "@mesa/shared";

/** Legacy jury URL. Refresh must land on the Runs security filter, never Italian copy. */
export const JURY_LEGACY_PATH = "/jury";

export const SECURITY_TYPE_PARAM = "type";
export const SECURITY_TYPE_VALUE = "security";
export const SECURITY_RUNS_HREF = "/runs?type=security";
export const SECURITY_BADGE_LABEL = "Security";

export const SECURITY_FILTER_COPY = {
  title: "Agent security testing",
  detail: "Attack note + permission check.",
  launch: "Launch a run from Agents",
  empty: "No security runs yet. Launch from Agents to create a run, then filter here.",
} as const;

export type RunsListType = "all" | "security";

/**
 * Existing Run discriminator — no extra schema field.
 * Jury/attacker writes ground_truth.category Security; injector Security catalog uses the same category.
 */
export function isSecurityRun(run: Pick<Run, "injection_plan">): boolean {
  return run.injection_plan?.ground_truth.category === "Security";
}

export function runsListTypeFromSearch(search: string | URLSearchParams): RunsListType {
  const params = typeof search === "string" ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search) : search;
  return params.get(SECURITY_TYPE_PARAM) === SECURITY_TYPE_VALUE ? "security" : "all";
}

export function filterRunsByType<T extends Pick<Run, "injection_plan">>(runs: readonly T[], type: RunsListType): T[] {
  if (type !== "security") return [...runs];
  return runs.filter((run) => isSecurityRun(run));
}

export function juryLegacyRedirectTo(): string {
  return SECURITY_RUNS_HREF;
}
