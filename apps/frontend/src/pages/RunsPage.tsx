import { useEffect, useState } from "react";
import { ChevronRight, Play } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import type { Agent, Run } from "@mesa/shared";
import { PhaseBadge, StatusBadge, VerifierBadge } from "@/components/badges";
import { Page, PageHeader } from "@/components/PageHeader";
import { ErrorState, StateCard } from "@/components/StateCard";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { getHarnessSnapshot, listAgents, type RunTraceLink } from "@/lib/api";
import { dashboardRunHref, linkFor } from "@/lib/dashboard";
import { formatDateTime, formatRunLabel, formatTaskLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; error: unknown }
  | { phase: "ready"; runs: Run[]; links: RunTraceLink[]; agents: Record<string, Agent> };

function groupSummary(runs: Run[]) {
  return runs.reduce(
    (acc, run) => {
      if (run.status === "passed") acc.passed += 1;
      else if (run.status === "failed") acc.failed += 1;
      else if (run.status === "error") acc.error += 1;
      else if (run.status === "running" || run.status === "queued") acc.running += 1;
      return acc;
    },
    { passed: 0, failed: 0, error: 0, running: 0 },
  );
}

export function RunsPage() {
  const { runId } = useParams<{ runId?: string }>();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  useDocumentTitle("Runs");

  async function fetchAll() {
    try {
      const [snapshot, agents] = await Promise.all([getHarnessSnapshot(), listAgents()]);
      setRefreshError(null);
      setState({
        phase: "ready",
        runs: snapshot.runs,
        links: snapshot.trace_links,
        agents: Object.fromEntries(agents.map((agent) => [agent.agent_id, agent])),
      });
    } catch (error) {
      setRefreshError(error);
      setState((current) => (current.phase === "ready" ? current : { phase: "error", error }));
    }
  }

  useEffect(() => { void fetchAll(); }, []);

  const runs = state.phase === "ready" ? state.runs : [];
  const active = runs.some((run) => run.status === "queued" || run.status === "running");

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => { void fetchAll(); }, 3000);
    return () => window.clearInterval(id);
  }, [active]);

  const groups = runs.reduce<{ agentId: string; runs: { run: Run; link: RunTraceLink | undefined }[] }[]>((acc, run, index) => {
    const link = state.phase === "ready" ? linkFor(state.links, run, index) : undefined;
    const existing = acc.find((group) => group.agentId === run.agent_id);
    if (existing) existing.runs.push({ run, link });
    else acc.push({ agentId: run.agent_id, runs: [{ run, link }] });
    return acc;
  }, []);

  useEffect(() => {
    if (seeded || runs.length === 0) return;
    const fromRoute = runId ? runs.find((run) => run.run_id === runId)?.agent_id : undefined;
    const first = fromRoute ?? groups[0]?.agentId;
    if (first) setExpanded(new Set([first]));
    setSeeded(true);
  }, [seeded, runs, runId, groups]);

  useEffect(() => {
    if (!runId) return;
    const run = runs.find((item) => item.run_id === runId);
    if (!run) return;
    setExpanded((prev) => {
      if (prev.has(run.agent_id)) return prev;
      const next = new Set(prev);
      next.add(run.agent_id);
      return next;
    });
  }, [runId, runs]);

  function toggleExpand(agentId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  return (
    <Page>
      <PageHeader title="Runs" subtitle="Tests launched from an agent, newest first." />
      {state.phase === "ready" && refreshError != null && <ErrorState error={refreshError} onRetry={() => void fetchAll()} />}
      {state.phase === "loading" && (
        <div className="space-y-3 rounded-2xl bg-card p-5 shadow-island">
          {[0, 1, 2].map((index) => <Skeleton key={index} className="h-12 w-full" />)}
        </div>
      )}
      {state.phase === "error" && <ErrorState error={state.error} onRetry={() => void fetchAll()} />}
      {state.phase === "ready" && groups.length === 0 && (
        <StateCard
          icon={Play}
          title="No runs yet"
          description="Launch a test from an agent."
          action={<Link to="/agents" className="text-sm font-medium text-primary hover:underline">Go to agents</Link>}
        />
      )}
      {state.phase === "ready" && groups.length > 0 && (
        <div className="overflow-hidden rounded-2xl bg-card shadow-island">
          {groups.map(({ agentId, runs: agentRuns }, index) => {
            const agent = state.agents[agentId];
            const isOpen = expanded.has(agentId);
            const summary = groupSummary(agentRuns.map((item) => item.run));
            return (
              <div key={agentId} className={cn(index < groups.length - 1 && "border-b border-border/30")}>
                <button type="button" onClick={() => toggleExpand(agentId)} className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-muted/30" aria-expanded={isOpen}>
                  <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent?.name ?? "Unknown agent"}</span>
                  <span className="flex shrink-0 items-center gap-3 text-xs">
                    {summary.running > 0 && <span className="text-info">{summary.running} running</span>}
                    {summary.passed > 0 && <span className="text-passed">{summary.passed} passed</span>}
                    {summary.failed > 0 && <span className="text-failed">{summary.failed} failed</span>}
                    {summary.error > 0 && <span className="text-error">{summary.error} error{summary.error === 1 ? "" : "s"}</span>}
                    <span className="text-muted-foreground">{agentRuns.length} run{agentRuns.length === 1 ? "" : "s"}</span>
                  </span>
                </button>
                {isOpen && (
                  <div className="border-t border-border/20 bg-muted/10">
                    {agentRuns.map(({ run, link }, rowIndex) => {
                      const task = agent?.tasks.find((item) => item.task_id === run.task_id);
                      const title = formatTaskLabel({ title: task?.title, task_id: run.task_id });
                      const when = link?.traces[0]?.started_at;
                      const sequence = agentRuns.length - rowIndex;
                      const verifier = link?.traces[0]?.outcome.verifier;
                      return (
                        <Link
                          key={run.run_id}
                          to={dashboardRunHref(run, link)}
                          className={cn(
                            "flex items-center gap-4 border-b border-border/15 py-3 pr-5 pl-9 last:border-0 hover:bg-muted/30",
                            run.run_id === runId && "bg-muted/40",
                          )}
                        >
                          <StatusBadge status={run.status} />
                          <span className="min-w-0 flex-1 truncate text-sm">{formatRunLabel({ taskTitle: title, at: when, sequence })}</span>
                          <span className="hidden rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">{run.task_id}</span>
                          <PhaseBadge phase={run.phase} />
                          {verifier ? (
                            <VerifierBadge passed={verifier.passed} checks={verifier.checks} />
                          ) : (
                            <span className="text-xs text-muted-foreground">No checks</span>
                          )}
                          <span className="shrink-0 text-xs text-muted-foreground">{when ? formatDateTime(when) : "—"}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}
