import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { Agent, Run, RunPhase, RunStatus } from "@mesa/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dashboardRunHref, isShoppingDemo, linkFor, needsAttentionRuns } from "@/lib/dashboard";
import { getHarnessSnapshot, listAgents, type HarnessSnapshot, type RunTraceLink } from "@/lib/api";
import { RUN_PHASE_LABELS } from "@/lib/run-launch";
import { cn } from "@/lib/utils";
import { EvalSection } from "@/pages/EvalScoreboardPage";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; agents: Agent[]; snapshot: HarnessSnapshot };

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function rowLatency(run: Run, link: RunTraceLink | undefined): { label: string; title: string } {
  const traceMs = link?.traces[0]?.totals.latency_ms;
  if (typeof traceMs === "number") {
    return { label: formatLatency(traceMs), title: "First trace totals.latency_ms" };
  }
  if (typeof run.duration_ms === "number") {
    return { label: formatLatency(run.duration_ms), title: "Run duration_ms" };
  }
  return { label: "—", title: "No latency yet" };
}

function taskTitle(agents: Agent[], run: Run): string {
  const agent = agents.find((item) => item.agent_id === run.agent_id);
  return agent?.tasks.find((task) => task.task_id === run.task_id)?.title ?? run.task_id;
}

function agentName(agents: Agent[], agentId: string): string {
  return agents.find((agent) => agent.agent_id === agentId)?.name ?? agentId;
}

function agentHealthScore(agentId: string, runs: Run[]): number {
  return runs.filter(r => r.agent_id === agentId && (r.status === "failed" || r.status === "error")).length;
}

function dotColor(status: RunStatus): string {
  if (status === "passed") return "bg-green-500";
  if (status === "failed" || status === "error") return "bg-red-500";
  return "bg-zinc-500/40";
}

function AgentSparkline({ agentId, runs }: { agentId: string; runs: Run[] }) {
  const agentRuns = runs.filter(r => r.agent_id === agentId).slice(-10);
  if (agentRuns.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5">
      {agentRuns.map(r => (
        <span key={r.run_id} className={cn("w-2 h-2 rounded-full shrink-0", dotColor(r.status))} title={r.status} />
      ))}
    </div>
  );
}

function PhaseBadge({ phase }: { phase: RunPhase }) {
  const styles: Record<RunPhase, string> = {
    baseline: "bg-blue-500/15 text-blue-400 border-blue-500/20",
    injected: "bg-amber-500/15 text-amber-400 border-amber-500/20",
    after_fix: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  };
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs", styles[phase])}>
      {RUN_PHASE_LABELS[phase]}
    </span>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  const styles: Record<RunStatus, string> = {
    queued: "bg-zinc-500/10 text-muted-foreground border-border",
    running: "bg-blue-500/15 text-blue-400 border-blue-500/20",
    passed: "bg-green-500/15 text-green-400 border-green-500/20",
    failed: "bg-red-500/15 text-red-400 border-red-500/20",
    error: "bg-red-500/15 text-red-400 border-red-500/20",
  };
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono", styles[status])}>
      {status}
    </span>
  );
}

function VerifierCell({ link }: { link: RunTraceLink | undefined }) {
  const traces = link?.traces ?? [];
  const first = traces[0];
  if (!first) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const { passed, checks } = first.outcome.verifier;
  const passedChecks = checks.filter((check) => check.passed).length;
  const summary = checks.map((check) => `${check.passed ? "pass" : "fail"} ${check.name}`).join(", ");
  return (
    <span className="inline-flex items-center gap-1.5" title={summary || "outcome.verifier"}>
      <span
        className={cn(
          "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono",
          passed
            ? "bg-green-500/15 text-green-400 border-green-500/20"
            : "bg-red-500/15 text-red-400 border-red-500/20",
        )}
      >
        {passed ? "passed" : "failed"}
      </span>
      <span className="font-mono text-xs text-muted-foreground">
        {passedChecks}/{checks.length}
      </span>
      {traces.length > 1 && (
        <span className="text-xs text-muted-foreground">+{traces.length - 1}</span>
      )}
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-card shadow-island p-5">
      <div className="text-2xl font-mono font-semibold tracking-tight">{value}</div>
      <div className="text-sm text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

function SectionLink({ to, children }: { to: string; children: string }) {
  return (
    <Link to={to} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
      {children}
    </Link>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [loadId, setLoadId] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    Promise.all([listAgents(), getHarnessSnapshot()])
      .then(([agents, snapshot]) => {
        if (!cancelled) setState({ phase: "ready", agents, snapshot });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Could not load this session.";
        setState({ phase: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [loadId]);

  return (
    <div className="px-5 pb-8 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between pt-2 pb-2 gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">MESA lab · Lab session</p>
        </div>
        <Button
          onClick={() => setLoadId((value) => value + 1)}
          size="sm"
          variant="outline"
          className="gap-1.5 rounded-full"
          disabled={state.phase === "loading"}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {state.phase === "loading" && <DashboardSkeleton />}
      {state.phase === "error" && (
        <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
          <p className="text-sm font-medium">Could not load this session.</p>
          <p className="text-xs font-mono text-muted-foreground break-all">{state.message}</p>
          <Button size="sm" variant="outline" className="rounded-full" onClick={() => setLoadId((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
      {state.phase === "ready" && (
        <DashboardBody
          agents={state.agents}
          snapshot={state.snapshot}
          onOpenRun={(href) => navigate(href)}
        />
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[88px]" />
        ))}
      </div>
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}

function DashboardBody({
  agents,
  snapshot,
  onOpenRun,
}: {
  agents: Agent[];
  snapshot: HarnessSnapshot;
  onOpenRun: (href: string) => void;
}) {
  const { counts } = snapshot;
  const runs = snapshot.runs;
  const shoppingDemo = agents.some(isShoppingDemo);

  const recentRuns = [...runs].sort((a, b) => b.run_id.localeCompare(a.run_id)).slice(0, 10);
  const rows = recentRuns.map((run, index) => ({ run, link: linkFor(snapshot.trace_links, run, index) }));
  const attention = needsAttentionRuns(runs, snapshot.trace_links);

  const hasAnyFailures = agents.some(a => agentHealthScore(a.agent_id, runs) > 0);
  const rankedAgents = hasAnyFailures
    ? [...agents].sort((a, b) => agentHealthScore(b.agent_id, runs) - agentHealthScore(a.agent_id, runs)).slice(0, 5)
    : [...agents].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 5);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Agents" value={String(counts.agents)} />
        <StatCard label="Runs" value={String(counts.runs)} />
        <StatCard label="Passed" value={String(counts.passed)} />
        <StatCard label="Failed" value={String(counts.failed + counts.error)} />
      </div>
      <p className="px-1 text-xs text-muted-foreground">
        Session · queued {counts.queued} · running {counts.running} · error {counts.error}
      </p>

      {attention.length > 0 && (
        <div className="rounded-2xl border border-border/50 bg-card/40 overflow-hidden">
          <div className="px-5 py-3 border-b border-border/40">
            <h2 className="text-sm font-medium text-muted-foreground">Needs attention</h2>
          </div>
          {attention.map(({ run, link }) => {
            const href = dashboardRunHref(run, link);
            const openLabel = link?.first_trace_id
              ? `Open trace ${link.first_trace_id}`
              : `Open run ${run.run_id}`;
            return (
              <Link
                key={run.run_id}
                to={href}
                title={openLabel}
                className="flex items-center gap-3 px-5 py-2.5 border-b border-border/30 last:border-0 hover:bg-muted/20 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{taskTitle(agents, run)}</div>
                  <div className="text-xs text-muted-foreground truncate" title={run.agent_id}>
                    {agentName(agents, run.agent_id)}
                  </div>
                </div>
                <StatusBadge status={run.status} />
                <span className="text-xs text-muted-foreground shrink-0">No fix replay yet</span>
              </Link>
            );
          })}
        </div>
      )}

      <div className="rounded-2xl bg-card shadow-island overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <h2 className="text-sm font-semibold">Agents</h2>
          <SectionLink to="/agents">Open agents</SectionLink>
        </div>
        {agents.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">No agents in this session.</p>
        ) : (
          rankedAgents.map((agent) => (
            <Link
              key={agent.agent_id}
              to="/agents"
              title={agent.agent_id}
              className="flex items-center gap-4 px-5 py-3.5 border-b border-border/30 last:border-0 hover:bg-muted/30 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium truncate">{agent.name}</span>
                  {isShoppingDemo(agent) && (
                    <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
                      demo
                    </span>
                  )}
                </div>
              </div>
              <AgentSparkline agentId={agent.agent_id} runs={runs} />
              <span className="text-xs text-muted-foreground shrink-0">
                {agent.tasks.length} task{agent.tasks.length === 1 ? "" : "s"}
              </span>
            </Link>
          ))
        )}
        {agents.length > 5 && (
          <div className="px-5 py-3 border-t border-border/40">
            <SectionLink to="/agents">{`View all ${agents.length} agents →`}</SectionLink>
          </div>
        )}
        {shoppingDemo && (
          <p className="px-5 py-3 text-xs text-muted-foreground border-t border-border/40">
            Shopping tasks are the demo example. The product is MESA.
          </p>
        )}
      </div>

      <EvalSection />

      <div className="rounded-2xl bg-card shadow-island overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <h2 className="text-sm font-semibold">Recent runs</h2>
          <div className="flex items-center gap-3">
            <SectionLink to="/runs">Open runs</SectionLink>
            <SectionLink to="/traces">Open traces</SectionLink>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">No runs in this lab session.</p>
        ) : (
          <Table className="table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[26%] text-xs">Task</TableHead>
                  <TableHead className="w-[20%] text-xs">Agent</TableHead>
                  <TableHead className="w-[12%] text-xs">Run type</TableHead>
                  <TableHead className="w-[12%] text-xs">Status</TableHead>
                  <TableHead className="w-[14%] text-xs">Checks</TableHead>
                  <TableHead className="w-[8%] text-xs text-right">Latency</TableHead>
                  <TableHead className="w-[8%] text-xs text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ run, link }) => {
                  const href = dashboardRunHref(run, link);
                  const when = link?.traces[0]?.started_at;
                  const latency = rowLatency(run, link);
                  const openLabel = link?.first_trace_id
                    ? `Open trace ${link.first_trace_id}`
                    : `Open run ${run.run_id}`;
                  return (
                    <TableRow
                      key={run.run_id}
                      className="cursor-pointer"
                      tabIndex={0}
                      title={openLabel}
                      onClick={() => onOpenRun(href)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onOpenRun(href);
                        }
                      }}
                    >
                      <TableCell className="overflow-hidden text-sm">
                        <Link
                          to={href}
                          className="block truncate hover:text-foreground"
                          title={openLabel}
                          onClick={(event) => event.stopPropagation()}
                        >
                          {taskTitle(agents, run)}
                        </Link>
                      </TableCell>
                      <TableCell className="overflow-hidden text-sm">
                        <div className="truncate" title={run.agent_id}>
                          {agentName(agents, run.agent_id)}
                        </div>
                      </TableCell>
                      <TableCell><PhaseBadge phase={run.phase} /></TableCell>
                      <TableCell><StatusBadge status={run.status} /></TableCell>
                      <TableCell><VerifierCell link={link} /></TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground" title={latency.title}>
                        {latency.label}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground" title={when ?? ""}>
                        {when ? relativeTime(when) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
        )}
        <p className="px-5 py-3 text-xs text-muted-foreground border-t border-border/40">
          A row opens the first trace. A run with no trace opens the run. The verifier column is outcome.verifier on that trace.
        </p>
      </div>
    </>
  );
}
