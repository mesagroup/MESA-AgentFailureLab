import { useEffect, useState } from "react";
import { Activity, Bot, Bug, Play, RefreshCw, Wrench } from "lucide-react";
import { Link } from "react-router-dom";
import type { Agent, Run } from "@mesa/shared";
import { PhaseBadge, StatusBadge, VerifierBadge } from "@/components/badges";
import { Page, PageHeader, SectionTitle } from "@/components/PageHeader";
import { ErrorState, StateCard } from "@/components/StateCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { getHarnessSnapshot, listAgents, type HarnessSnapshot, type RunTraceLink } from "@/lib/api";
import { dashboardRunHref, isShoppingDemo, linkFor } from "@/lib/dashboard";
import { KIND_LABEL, formatDuration, formatRunLabel, formatTaskLabel } from "@/lib/labels";

const FLOW = [
  { to: "/agents", title: "Agent", detail: "Choose the agent under test", icon: Bot },
  { to: "/agents", title: "Test", detail: "Run a baseline with faults off", icon: Play },
  { to: "/agents", title: "Fault", detail: "Inject a fault from the catalog", icon: Bug },
  { to: "/traces", title: "Trace", detail: "Inspect the culprit step", icon: Activity },
  { to: "/runs", title: "Fix", detail: "Replay with a fix and compare", icon: Wrench },
] as const;

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; error: unknown }
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

function taskTitle(agents: Agent[], run: Run): string {
  const agent = agents.find((item) => item.agent_id === run.agent_id);
  const task = agent?.tasks.find((item) => item.task_id === run.task_id);
  return formatTaskLabel({ title: task?.title, task_id: run.task_id });
}

function agentName(agents: Agent[], agentId: string): string {
  return agents.find((agent) => agent.agent_id === agentId)?.name ?? "Unknown agent";
}

function rowTime(link: RunTraceLink | undefined): string | null {
  return link?.traces[0]?.started_at ?? link?.traces[0]?.ended_at ?? null;
}

export function DashboardPage() {
  const [loadId, setLoadId] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  useDocumentTitle("Dashboard");

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    Promise.all([listAgents(), getHarnessSnapshot()])
      .then(([agents, snapshot]) => {
        if (!cancelled) setState({ phase: "ready", agents, snapshot });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ phase: "error", error });
      });
    return () => { cancelled = true; };
  }, [loadId]);

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        subtitle="MESA Agent Failure Lab"
        actions={
          <Button onClick={() => setLoadId((value) => value + 1)} size="sm" variant="outline" className="gap-1.5 rounded-full" disabled={state.phase === "loading"}>
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        }
      />

      <section className="rounded-2xl bg-card shadow-island">
        <SectionTitle>Demo flow</SectionTitle>
        <ol className="grid gap-px bg-border/40 sm:grid-cols-5">
          {FLOW.map(({ to, title, detail, icon: Icon }, index) => (
            <li key={title} className="bg-card">
              <Link to={to} className="flex h-full flex-col gap-2 px-4 py-4 hover:bg-muted/40">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                  {index + 1}. {title}
                </span>
                <span className="text-sm text-muted-foreground">{detail}</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      {state.phase === "loading" && <DashboardSkeleton />}
      {state.phase === "error" && <ErrorState error={state.error} onRetry={() => setLoadId((value) => value + 1)} />}
      {state.phase === "ready" && <DashboardBody agents={state.agents} snapshot={state.snapshot} />}
    </Page>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-[88px]" />)}
      </div>
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}

function DashboardBody({ agents, snapshot }: { agents: Agent[]; snapshot: HarnessSnapshot }) {
  const { counts } = snapshot;
  const rows = snapshot.runs.map((run, index) => ({
    run,
    link: linkFor(snapshot.trace_links, run, index),
    sequence: snapshot.runs.length - index,
  }));
  const inProgress = counts.queued + counts.running;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Agents" value={String(counts.agents)} />
        <Stat label="Runs" value={String(counts.runs)} />
        <Stat label="Passed" value={String(counts.passed)} />
        <Stat label="Failed" value={String(counts.failed)} />
        <Stat label="Errors" value={String(counts.error)} />
      </div>
      {inProgress > 0 && (
        <p className="px-1 text-sm text-muted-foreground">
          {inProgress} run{inProgress === 1 ? " is" : "s are"} still in progress.
        </p>
      )}

      <section className="overflow-hidden rounded-2xl bg-card shadow-island">
        <SectionTitle aside={<Link to="/agents" className="text-xs text-muted-foreground hover:text-foreground">Open agents</Link>}>
          Agents
        </SectionTitle>
        {agents.length === 0 ? (
          <StateCard icon={Bot} title="No agents in this session" action={<Button size="sm" className="rounded-full" nativeButton={false} render={<Link to="/agents" />}>Register an agent</Button>} />
        ) : (
          agents.map((agent) => (
            <Link
              key={agent.agent_id}
              to={`/agents/${encodeURIComponent(agent.agent_id)}`}
              className="flex items-center gap-4 border-b border-border/30 px-5 py-3.5 last:border-0 hover:bg-muted/30"
            >
              <div className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{agent.name}</span>
                  <span className="text-xs text-muted-foreground">{KIND_LABEL[agent.instance.kind]}</span>
                  {isShoppingDemo(agent) && (
                    <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Demo
                    </span>
                  )}
                </span>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {agent.tasks.length} task{agent.tasks.length === 1 ? "" : "s"}
              </span>
            </Link>
          ))
        )}
      </section>

      <section className="overflow-hidden rounded-2xl bg-card shadow-island">
        <SectionTitle
          aside={
            <span className="flex items-center gap-3">
              <Link to="/runs" className="text-xs text-muted-foreground hover:text-foreground">Open runs</Link>
              <Link to="/traces" className="text-xs text-muted-foreground hover:text-foreground">Open traces</Link>
            </span>
          }
        >
          Recent runs
        </SectionTitle>
        {rows.length === 0 ? (
          <StateCard icon={Play} title="No runs yet" description="Launch a test from an agent." action={<Button size="sm" className="rounded-full" nativeButton={false} render={<Link to="/agents" />}>Go to agents</Button>} />
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[28%] text-xs">Run</TableHead>
                <TableHead className="w-[16%] text-xs">Agent</TableHead>
                <TableHead className="w-[16%] text-xs">Task</TableHead>
                <TableHead className="w-[12%] text-xs">Phase</TableHead>
                <TableHead className="w-[10%] text-xs">Status</TableHead>
                <TableHead className="w-[12%] text-xs">Verifier</TableHead>
                <TableHead className="w-[6%] text-right text-xs">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ run, link, sequence }) => {
                const href = dashboardRunHref(run, link);
                const when = rowTime(link);
                const title = taskTitle(agents, run);
                const verifier = link?.traces[0]?.outcome.verifier;
                const latency = link?.traces[0]?.totals.latency_ms ?? run.duration_ms;
                return (
                  <TableRow key={run.run_id}>
                    <TableCell className="overflow-hidden text-sm">
                      <Link to={href} className="block truncate font-medium hover:underline">
                        {formatRunLabel({ taskTitle: title, at: when, sequence })}
                      </Link>
                      <span className="text-xs text-muted-foreground">{when ? relativeTime(when) : "—"}</span>
                    </TableCell>
                    <TableCell className="overflow-hidden text-sm">
                      <Link to={`/agents/${encodeURIComponent(run.agent_id)}`} className="block truncate hover:underline">
                        {agentName(agents, run.agent_id)}
                      </Link>
                    </TableCell>
                    <TableCell className="overflow-hidden text-sm">
                      <span className="block truncate">{title}</span>
                      <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{run.task_id}</span>
                    </TableCell>
                    <TableCell><PhaseBadge phase={run.phase} /></TableCell>
                    <TableCell><StatusBadge status={run.status} /></TableCell>
                    <TableCell>
                      {verifier ? <VerifierBadge passed={verifier.passed} checks={verifier.checks} /> : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {typeof latency === "number" ? formatDuration(latency) : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-card p-5 shadow-island">
      <div className="font-mono text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-sm text-muted-foreground">{label}</div>
    </div>
  );
}
