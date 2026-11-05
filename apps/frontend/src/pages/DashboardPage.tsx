import { useEffect, useState } from "react";
import { Activity, Bot, Play, RefreshCw, Shield } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { Agent, Run, RunPhase, RunStatus } from "@mesa/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dashboardRunHref, isShoppingDemo, linkFor } from "@/lib/dashboard";
import { getHarnessSnapshot, listAgents, type HarnessSnapshot, type RunTraceLink } from "@/lib/api";
import { cn } from "@/lib/utils";

const DESTINATIONS = [
  { to: "/jury", title: "Giuria", detail: "Nota malevola", icon: Shield },
  { to: "/agents", title: "Agents", detail: "Registered agents", icon: Bot },
  { to: "/runs", title: "Runs", detail: "Testa agente", icon: Play },
  { to: "/traces", title: "Traces", detail: "Ispeziona traccia", icon: Activity },
] as const;

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

function PhaseBadge({ phase }: { phase: RunPhase }) {
  const styles: Record<RunPhase, string> = {
    baseline: "bg-blue-500/15 text-blue-400 border-blue-500/20",
    injected: "bg-amber-500/15 text-amber-400 border-amber-500/20",
    after_fix: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  };
  const labels: Record<RunPhase, string> = {
    baseline: "baseline",
    injected: "injected",
    after_fix: "after fix",
  };
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono", styles[phase])}>
      {labels[phase]}
    </span>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  const styles: Record<RunStatus, string> = {
    queued: "bg-zinc-500/10 text-muted-foreground border-border",
    running: "bg-blue-500/15 text-blue-400 border-blue-500/20",
    passed: "bg-green-500/15 text-green-400 border-green-500/20",
    failed: "bg-red-500/15 text-red-400 border-red-500/20",
    error: "bg-amber-500/15 text-amber-400 border-amber-500/20",
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
        const message = error instanceof Error ? error.message : "The harness session did not load.";
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
          <p className="text-sm text-muted-foreground mt-0.5">CHAOS.AI lab · harness session</p>
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {DESTINATIONS.map(({ to, title, detail, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="rounded-2xl bg-card shadow-island p-5 flex items-start gap-3 hover:bg-muted/40 transition-colors"
          >
            <Icon className="h-4 w-4 mt-0.5 text-muted-foreground" />
            <span>
              <span className="block text-sm font-semibold">{title}</span>
              <span className="block text-xs text-muted-foreground mt-0.5">{detail}</span>
            </span>
          </Link>
        ))}
      </div>

      {state.phase === "loading" && <DashboardSkeleton />}
      {state.phase === "error" && (
        <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
          <p className="text-sm font-medium">The harness session did not load.</p>
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
  const shoppingDemo = agents.some(isShoppingDemo);
  const rows = snapshot.runs.map((run, index) => ({ run, link: linkFor(snapshot.trace_links, run, index) }));

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Agents" value={String(counts.agents)} />
        <StatCard label="Runs" value={String(counts.runs)} />
        <StatCard label="Passed" value={String(counts.passed)} />
        <StatCard label="Failed" value={String(counts.failed)} />
      </div>
      <p className="px-1 text-xs text-muted-foreground">
        {counts.scope} · queued {counts.queued} · running {counts.running} · error {counts.error}
      </p>

      <div className="rounded-2xl bg-card shadow-island overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <h2 className="text-sm font-semibold">Agents</h2>
          <SectionLink to="/agents">Open agents</SectionLink>
        </div>
        {agents.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">No agents in this session.</p>
        ) : (
          agents.map((agent) => (
            <Link
              key={agent.agent_id}
              to="/agents"
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
                <p className="text-xs font-mono text-muted-foreground/70 truncate mt-0.5">{agent.agent_id}</p>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                {agent.tasks.length} task{agent.tasks.length === 1 ? "" : "s"}
              </span>
            </Link>
          ))
        )}
        {shoppingDemo && (
          <p className="px-5 py-3 text-xs text-muted-foreground border-t border-border/40">
            Shopping tasks are the demo example. The lab is CHAOS.AI.
          </p>
        )}
      </div>

      <div className="rounded-2xl bg-card shadow-island overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <h2 className="text-sm font-semibold">Recent runs</h2>
          <div className="flex items-center gap-3">
            <SectionLink to="/runs">Open runs</SectionLink>
            <SectionLink to="/traces">Open traces</SectionLink>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">No runs in this harness session.</p>
        ) : (
          <Table className="table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[16%] text-xs">Run</TableHead>
                  <TableHead className="w-[16%] text-xs">Agent</TableHead>
                  <TableHead className="w-[18%] text-xs">Task</TableHead>
                  <TableHead className="w-[11%] text-xs">Phase</TableHead>
                  <TableHead className="w-[11%] text-xs">Status</TableHead>
                  <TableHead className="w-[12%] text-xs">Verifier</TableHead>
                  <TableHead className="w-[8%] text-xs text-right">Latency</TableHead>
                  <TableHead className="w-[8%] text-xs text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ run, link }) => {
                  const href = dashboardRunHref(run, link);
                  const when = link?.traces[0]?.started_at;
                  const latency = rowLatency(run, link);
                  return (
                    <TableRow
                      key={run.run_id}
                      className="cursor-pointer"
                      tabIndex={0}
                      onClick={() => onOpenRun(href)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onOpenRun(href);
                        }
                      }}
                    >
                      <TableCell className="overflow-hidden font-mono text-xs text-muted-foreground">
                        <Link
                          to={href}
                          className="block truncate hover:text-foreground"
                          title={link?.first_trace_id ? `Open trace ${link.first_trace_id}` : `Open run ${run.run_id}`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          {run.run_id}
                        </Link>
                      </TableCell>
                      <TableCell className="overflow-hidden text-sm">
                        <div className="truncate">{agentName(agents, run.agent_id)}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground">{run.agent_id}</div>
                      </TableCell>
                      <TableCell className="overflow-hidden text-sm text-muted-foreground">
                        <div className="truncate">{taskTitle(agents, run)}</div>
                        <div className="truncate font-mono text-xs">{run.task_id}</div>
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
