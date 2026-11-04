import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { listAgents, listRuns } from "@/lib/api";
import type { Agent, Run, RunPhase, RunStatus } from "@mesa/shared";

function PhaseBadge({ phase }: { phase: RunPhase }) {
  const styles: Record<RunPhase, string> = {
    baseline: "bg-blue-500/15 text-blue-500 border-blue-500/20",
    injected: "bg-amber-500/15 text-amber-500 border-amber-500/20",
    after_fix: "bg-emerald-500/15 text-emerald-500 border-emerald-500/20",
  };
  const labels: Record<RunPhase, string> = { baseline: "baseline", injected: "injected", after_fix: "after fix" };
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono", styles[phase])}>
      {labels[phase]}
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
  const { runId } = useParams<{ runId?: string }>();
  const navigate = useNavigate();
  const [runs, setRuns] = useState<Run[]>([]);
  const [agentMap, setAgentMap] = useState<Record<string, Agent>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchAll() {
    try {
      const [fetchedRuns, fetchedAgents] = await Promise.all([listRuns(), listAgents()]);
      setRuns(fetchedRuns.sort((a, b) => b.run_id.localeCompare(a.run_id)));
      setAgentMap(Object.fromEntries(fetchedAgents.map((a) => [a.agent_id, a])));
    } catch {
      // keep existing state
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchAll(); }, []);

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

  const groups = runs.reduce<{ agentId: string; runs: Run[] }[]>((acc, run) => {
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

  function handleRunClick(run: Run) {
    const traceId = run.trace_ids[0];
    if (traceId) {
      navigate(`/traces/${encodeURIComponent(traceId)}`);
      return;
    }
    navigate(`/runs/${encodeURIComponent(run.run_id)}`);
  }

  return (
    <div className="px-5 pb-8 max-w-5xl mx-auto space-y-4">
      <div className="pt-2 pb-2">
        <h1 className="text-xl font-semibold">Runs</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Test history · Track 03 CHAOS.AI</p>
      </div>

      {loading ? (
        <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-2xl bg-card shadow-island py-16 text-center">
          <p className="text-sm text-muted-foreground">No runs yet.</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Launch a run from an agent to get started.</p>
        </div>
      ) : (
        <div className="rounded-2xl bg-card shadow-island overflow-hidden">
          {groups.map(({ agentId, runs: agentRuns }, idx) => {
            const agent = agentMap[agentId];
            const isOpen = expanded.has(agentId);
            const { passed, failed, running } = groupSummary(agentRuns);
            const isLast = idx === groups.length - 1;

            return (
              <div key={agentId} className={cn(!isLast && "border-b border-border/30")}>
                {/* Group header */}
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

                {/* Expanded runs */}
                {isOpen && (
                  <div className="border-t border-border/20 bg-muted/10">
                    {agentRuns.map((run) => (
                      <div
                        key={run.run_id}
                        onClick={() => handleRunClick(run)}
                        className={cn(
                          "flex items-center gap-4 pl-9 pr-5 py-3 border-b border-border/15 last:border-0 hover:bg-muted/30 transition-colors cursor-pointer",
                          run.run_id === runId && "bg-muted/40",
                        )}
                      >
                        <StatusDot status={run.status} />
                        <span className="font-mono text-xs text-muted-foreground/50 w-28 shrink-0 truncate">
                          {run.run_id.slice(0, 12)}…
                        </span>
                        <span className="font-mono text-xs text-muted-foreground/40 w-36 shrink-0 truncate">
                          {run.task_id}
                        </span>
                        <PhaseBadge phase={run.phase} />
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
                          {run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(2)}s` : "—"}
                        </span>
                      </div>
                    ))}
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
