import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { listAgents, listRuns } from "@/lib/api";
import { childRunsOf, firstTraceId, runHref, traceHref } from "@/lib/after-fix";
import { runListClickHref } from "@/lib/run-detail";
import { formatRunDuration, RUN_PHASE_LABELS, taskForRun, taskTitleForRun } from "@/lib/run-launch";
import {
  SECURITY_BADGE_LABEL,
  SECURITY_FILTER_COPY,
  SECURITY_RUNS_HREF,
  filterRunsByType,
  isSecurityRun,
  runsListTypeFromSearch,
} from "@/lib/security-runs";
import type { Agent, Run, RunPhase, RunStatus } from "@mesa/shared";

function PhaseBadge({ phase }: { phase: RunPhase }) {
  const styles: Record<RunPhase, string> = {
    baseline: "bg-blue-500/15 text-blue-500 border-blue-500/20",
    injected: "bg-amber-500/15 text-amber-500 border-amber-500/20",
    after_fix: "bg-emerald-500/15 text-emerald-500 border-emerald-500/20",
  };
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs", styles[phase])}>
      {RUN_PHASE_LABELS[phase]}
    </span>
  );
}

function SecurityBadge() {
  return (
    <span className="inline-flex items-center rounded-md border border-violet-500/20 bg-violet-500/15 px-2 py-0.5 text-xs font-mono text-violet-500">
      {SECURITY_BADGE_LABEL}
    </span>
  );
}

function StatusDot({ status }: { status: RunStatus }) {
  const styles: Record<RunStatus, string> = {
    queued: "bg-muted-foreground/40",
    running: "bg-blue-500 animate-pulse",
    passed: "bg-green-500",
    failed: "bg-red-500",
    error: "bg-red-500",
  };
  return <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", styles[status])} />;
}

function groupSummary(runs: Run[]) {
  return runs.reduce(
    (acc, r) => {
      if (r.status === "passed") acc.passed++;
      else if (r.status === "failed" || r.status === "error") acc.failed++;
      else if (r.status === "running" || r.status === "queued") acc.running++;
      return acc;
    },
    { passed: 0, failed: 0, running: 0 }
  );
}

export function RunsPage() {
  const [searchParams] = useSearchParams();
  const listType = runsListTypeFromSearch(searchParams);
  const [runs, setRuns] = useState<Run[]>([]);
  const [agentMap, setAgentMap] = useState<Record<string, Agent>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const openedFirstGroup = useRef(false);

  async function fetchAll() {
    try {
      const [fetchedRuns, fetchedAgents] = await Promise.all([listRuns(), listAgents()]);
      const sorted = fetchedRuns.sort((a, b) => b.run_id.localeCompare(a.run_id));
      setRuns(sorted);
      setAgentMap(Object.fromEntries(fetchedAgents.map((a) => [a.agent_id, a])));
      if (!openedFirstGroup.current) {
        const firstAgent = sorted[0]?.agent_id;
        if (firstAgent) {
          openedFirstGroup.current = true;
          setExpanded(new Set([firstAgent]));
        }
      }
    } catch {
      // keep existing state
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchAll(); }, []);

  useEffect(() => {
    const hasActive = runs.some((r) => r.status === "queued" || r.status === "running");
    if (hasActive && !pollingRef.current) {
      pollingRef.current = setInterval(fetchAll, 3000);
    } else if (!hasActive && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    return () => {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    };
  }, [runs]);

  useEffect(() => {
    if (listType !== "security") return;
    const first = filterRunsByType(runs, "security")[0]?.agent_id;
    if (!first) return;
    setExpanded((prev) => {
      if (prev.has(first)) return prev;
      const next = new Set(prev);
      next.add(first);
      return next;
    });
  }, [listType, runs]);

  const typedRuns = filterRunsByType(runs, listType);

  const filteredRuns = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return typedRuns;
    return typedRuns.filter((run) => {
      const agent = agentMap[run.agent_id];
      const task = taskForRun(agent, run);
      const haystack = [
        run.run_id,
        run.task_id,
        run.status,
        run.phase,
        agent?.name ?? "",
        agent?.agent_id ?? "",
        task?.title ?? "",
        task?.prompt ?? "",
        run.error_message ?? "",
        isSecurityRun(run) ? "security" : "",
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [typedRuns, agentMap, filter]);

  const groups = filteredRuns.reduce<{ agentId: string; runs: Run[] }[]>((acc, run) => {
    const existing = acc.find((g) => g.agentId === run.agent_id);
    if (existing) { existing.runs.push(run); }
    else { acc.push({ agentId: run.agent_id, runs: [run] }); }
    return acc;
  }, []);

  function toggleExpand(agentId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId); else next.add(agentId);
      return next;
    });
  }

  return (
    <div className="px-5 pb-8 pt-4 max-w-5xl mx-auto space-y-4">
      <div className="pb-2 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">Runs</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Test history · Track 03 CHAOS.AI</p>
          </div>
          {!loading && runs.length > 0 && (
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter title, task, phase…"
                className="pl-9 h-9 text-sm"
                aria-label="Filter runs"
              />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/runs"
            className={cn(
              "inline-flex items-center rounded-full border px-3 py-1 text-xs transition-colors",
              listType === "all"
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            All
          </Link>
          <Link
            to={SECURITY_RUNS_HREF}
            className={cn(
              "inline-flex items-center rounded-full border px-3 py-1 text-xs transition-colors",
              listType === "security"
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {SECURITY_BADGE_LABEL}
          </Link>
        </div>
        {listType === "security" && (
          <p className="text-sm text-muted-foreground">
            {SECURITY_FILTER_COPY.title}. {SECURITY_FILTER_COPY.detail}{" "}
            <Link to="/agents" className="underline-offset-2 hover:underline">
              {SECURITY_FILTER_COPY.launch}
            </Link>
          </p>
        )}
      </div>

      {loading ? (
        <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-2xl bg-card shadow-island py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {listType === "security" ? SECURITY_FILTER_COPY.empty : "No runs yet."}
          </p>
          {listType !== "security" && (
            <p className="text-xs text-muted-foreground/60 mt-1">Launch a run from an agent to get started.</p>
          )}
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-2xl bg-card shadow-island py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {listType === "security" ? SECURITY_FILTER_COPY.empty : "No runs match this filter."}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl bg-card shadow-island">
          {groups.map(({ agentId, runs: agentRuns }, idx) => {
            const agent = agentMap[agentId];
            const isOpen = expanded.has(agentId) || Boolean(filter.trim());
            const { passed, failed, running } = groupSummary(agentRuns);
            const isLast = idx === groups.length - 1;

            return (
              <div key={agentId} className={cn(!isLast && "border-b border-border/30")}>
                <button
                  type="button"
                  onClick={() => toggleExpand(agentId)}
                  className="w-full flex items-center gap-4 px-5 py-4 hover:bg-muted/30 transition-colors text-left"
                >
                  <ChevronRight className={cn(
                    "h-3.5 w-3.5 text-muted-foreground/50 shrink-0 transition-transform duration-150",
                    isOpen && "rotate-90"
                  )} />

                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{agent?.name ?? agentId}</span>
                    <span className="font-mono text-xs text-muted-foreground/40 ml-2">{agentId}</span>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 text-xs">
                    {running > 0 && (
                      <span className="flex items-center gap-1.5 text-blue-500">
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
                        {running} running
                      </span>
                    )}
                    {passed > 0 && <span className="text-green-600">{passed} passed</span>}
                    {failed > 0 && <span className="text-red-500">{failed} failed</span>}
                    <span className="text-muted-foreground/40">
                      {agentRuns.length} run{agentRuns.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-border/20 bg-muted/10 pt-1">
                    {agentRuns.map((run) => {
                      const title = taskTitleForRun(agent, run);
                      const task = taskForRun(agent, run);
                      return (
                        <div
                          key={run.run_id}
                          className="pl-9 pr-5 py-3 border-b border-border/15 last:border-0 first:pt-3.5 hover:bg-muted/30 transition-colors"
                        >
                          <Link
                            to={runListClickHref(run)}
                            title={run.run_id}
                            className="block space-y-1"
                          >
                            <div className="flex items-center gap-3">
                              <StatusDot status={run.status} />
                              <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium truncate">{title}</span>
                                <span className="font-mono text-[11px] text-muted-foreground">{run.task_id}</span>
                                <PhaseBadge phase={run.phase} />
                                {isSecurityRun(run) && <SecurityBadge />}
                                <span className={cn(
                                  "text-xs font-mono",
                                  run.status === "passed" && "text-green-600",
                                  (run.status === "failed" || run.status === "error") && "text-red-500",
                                  run.status === "running" && "text-blue-500",
                                  run.status === "queued" && "text-muted-foreground/40",
                                )}>
                                  {run.status}
                                </span>
                                <span className="font-mono text-xs text-muted-foreground/40 ml-auto shrink-0">
                                  {formatRunDuration(run.duration_ms)}
                                </span>
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-1 pl-5">
                              {task?.prompt ?? run.run_id}
                            </p>
                          </Link>
                          <RunLineage run={run} peers={agentRuns} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RunLineage({ run, peers }: { run: Run; peers: Run[] }) {
  const parentTo = runHref(run.parent_run_id);
  const parentPeer = peers.find((item) => item.run_id === run.parent_run_id);
  const parentTraceTo = traceHref(firstTraceId(parentPeer));
  const children = childRunsOf(peers, run.run_id);
  if (!parentTo && children.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 pl-5 text-xs text-muted-foreground">
      {parentTo && (
        <Link
          to={parentTo}
          className="hover:text-foreground underline-offset-2 hover:underline font-mono"
        >
          parent {run.parent_run_id}
        </Link>
      )}
      {parentTraceTo && (
        <Link
          to={parentTraceTo}
          className="hover:text-foreground underline-offset-2 hover:underline"
        >
          parent trace
        </Link>
      )}
      {children.map((child) => {
        const href = runHref(child.run_id);
        const tHref = traceHref(firstTraceId(child));
        return (
          <span key={child.run_id} className="font-mono">
            {href ? (
              <Link to={href} className="hover:text-foreground underline-offset-2 hover:underline">
                child {child.run_id.slice(0, 12)}…
              </Link>
            ) : (
              `child ${child.run_id}`
            )}
            {tHref && (
              <>
                {" "}
                <Link to={tHref} className="hover:text-foreground underline-offset-2 hover:underline">
                  trace
                </Link>
              </>
            )}
          </span>
        );
      })}
    </div>
  );
}
