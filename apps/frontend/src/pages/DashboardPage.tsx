import { PlusCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AGENTS,
  GLOBAL_STATS,
  RECENT_RUNS,
  agentSuccessRate,
  type DayData,
  type DayStatus,
  type MockAgent,
  type RunPhase,
  type RunResult,
} from "@/data/mock";
import { cn } from "@/lib/utils";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function barColor(status: DayStatus): string {
  switch (status) {
    case "pass": return "bg-green-500";
    case "fail": return "bg-red-400";
    case "partial": return "bg-amber-400";
    default: return "bg-zinc-200 dark:bg-zinc-700";
  }
}

function UptimeBars({ history }: { history: DayData[] }) {
  return (
    <div className="flex gap-[2px] items-end">
      {history.map((day) => (
        <div
          key={day.date}
          title={
            day.total > 0
              ? `${day.date}: ${day.passed}/${day.total} passed`
              : `${day.date}: no data`
          }
          className={cn("h-6 w-[5px] rounded-[2px] flex-shrink-0 cursor-default", barColor(day.status))}
        />
      ))}
    </div>
  );
}

function AgentUptimeRow({ agent }: { agent: MockAgent }) {
  const rate = agentSuccessRate(agent);
  const pct = (rate * 100).toFixed(1);
  const isHealthy = rate >= 0.9;

  return (
    <div className="flex items-center gap-4 py-3 border-b border-border/50 last:border-0">
      <div className="w-44 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full flex-shrink-0",
              isHealthy ? "bg-green-500" : "bg-red-500"
            )}
          />
          <span className="text-sm font-medium truncate">{agent.name}</span>
        </div>
        <span className="text-xs text-muted-foreground ml-4">
          {agent.kind === "reference" ? "reference" : "external"}
        </span>
      </div>

      <div className="flex-1 min-w-0 overflow-hidden">
        <UptimeBars history={agent.history} />
      </div>

      <div className="w-16 text-right flex-shrink-0">
        <span className={cn("text-sm font-mono font-medium", isHealthy ? "text-green-500" : "text-red-400")}>
          {pct}%
        </span>
      </div>
    </div>
  );
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

function ResultBadge({ result }: { result: RunResult }) {
  if (result === "running") {
    return <Badge variant="outline" className="text-xs font-mono">running</Badge>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono",
        result === "passed"
          ? "bg-green-500/15 text-green-400 border-green-500/20"
          : "bg-red-500/15 text-red-400 border-red-500/20"
      )}
    >
      {result}
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

export function DashboardPage() {
  const navigate = useNavigate();
  const { totalRuns, successRate, avgLatencyMs, activeAgents } = GLOBAL_STATS;

  return (
    <div className="px-5 pb-8 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between pt-2 pb-2">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Last 90 days · Track 03 CHAOS.AI</p>
        </div>
        <Button onClick={() => navigate("/runs")} size="sm" variant="outline" className="gap-1.5 rounded-full">
          <PlusCircle className="h-3.5 w-3.5" />
          New run
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total runs" value={totalRuns.toString()} />
        <StatCard label="Success rate" value={`${(successRate * 100).toFixed(1)}%`} />
        <StatCard label="Avg latency" value={`${(avgLatencyMs / 1000).toFixed(2)}s`} />
        <StatCard label="Active agents" value={activeAgents.toString()} />
      </div>

      <div className="rounded-2xl bg-card shadow-island p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">Agent status</h2>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-green-500 inline-block" />pass</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-amber-400 inline-block" />partial</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-red-400 inline-block" />fail</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-zinc-200 dark:bg-zinc-700 inline-block" />no data</span>
          </div>
        </div>
        {AGENTS.map((agent) => (
          <AgentUptimeRow key={agent.agent_id} agent={agent} />
        ))}
      </div>

      <div className="rounded-2xl bg-card shadow-island overflow-hidden">
        <div className="px-5 py-4 border-b border-border/50">
          <h2 className="text-sm font-semibold">Recent runs</h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-xs">Run</TableHead>
              <TableHead className="text-xs">Agent</TableHead>
              <TableHead className="text-xs">Task</TableHead>
              <TableHead className="text-xs">Phase</TableHead>
              <TableHead className="text-xs">Result</TableHead>
              <TableHead className="text-xs text-right">Latency</TableHead>
              <TableHead className="text-xs text-right">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {RECENT_RUNS.map((run) => (
              <TableRow
                key={run.run_id}
                className="cursor-pointer"
                onClick={() => navigate(`/traces/${run.run_id}`)}
              >
                <TableCell className="font-mono text-xs text-muted-foreground">{run.run_id}</TableCell>
                <TableCell className="text-sm">{run.agent_name}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{run.task_name}</TableCell>
                <TableCell><PhaseBadge phase={run.phase} /></TableCell>
                <TableCell><ResultBadge result={run.result} /></TableCell>
                <TableCell className="text-right font-mono text-xs text-muted-foreground">
                  {(run.latency_ms / 1000).toFixed(2)}s
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">
                  {relativeTime(run.started_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
