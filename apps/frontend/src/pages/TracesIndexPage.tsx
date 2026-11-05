import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Agent, Trace } from "@mesa/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { listAgents, listTraceIndex } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  TRACE_SOURCES,
  describeTraceListFailure,
  sortTracesNewestFirst,
  traceListPath,
  traceListSource,
  traceSourceParam,
  type TraceListFilters,
} from "@/lib/traces";
import { TracePullPanel } from "@/pages/TracePullPanel";
import { TraceSourceBadge } from "@/pages/TraceSourceBadge";

function statusClass(status: Trace["status"]): string {
  if (status === "completed") return "text-green-600";
  if (status === "timeout") return "text-amber-500";
  if (status === "failed" || status === "error") return "text-red-500";
  return "text-muted-foreground";
}

function formatStarted(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TracesIndexPage() {
  const [params, setParams] = useSearchParams();
  const [traces, setTraces] = useState<Trace[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const filters: TraceListFilters = {
    agentId: params.get("agent") ?? "",
    source: traceSourceParam(params.get("source")),
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
  };
  const listQuery = traceListPath(filters);
  const rangeError = listQuery.ok ? null : listQuery.message;

  useEffect(() => {
    if (rangeError) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([listTraceIndex(filters), listAgents()])
      .then(([nextTraces, nextAgents]) => {
        if (cancelled) return;
        setTraces(nextTraces);
        setAgents(nextAgents);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(describeTraceListFailure(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters.agentId, filters.source, filters.from, filters.to, rangeError, reloadKey]);

  function updateFilters(next: Partial<TraceListFilters>) {
    const merged = { ...filters, ...next };
    const search = new URLSearchParams();
    if (merged.agentId) search.set("agent", merged.agentId);
    if (merged.source) search.set("source", merged.source);
    if (merged.from) search.set("from", merged.from);
    if (merged.to) search.set("to", merged.to);
    setParams(search, { replace: true });
  }

  const agentOptions = useMemo(() => {
    const known = new Map(agents.map((agent) => [agent.agent_id, agent.name]));
    for (const trace of traces) {
      if (!known.has(trace.agent_id)) known.set(trace.agent_id, trace.agent_id);
    }
    return [...known.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [agents, traces]);

  const selectedAgent = agents.find((agent) => agent.agent_id === filters.agentId) ?? null;
  const visible = sortTracesNewestFirst(traces);
  const filtersActive = Boolean(filters.agentId || filters.source || filters.from || filters.to);

  return (
    <div className="px-5 pb-8 max-w-5xl mx-auto space-y-4">
      <div className="flex items-start justify-between gap-3 pt-2 pb-2">
        <div>
          <h1 className="text-xl font-semibold">Traces</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Harness, demo seed, and OTel traces. Filters are sent to the lab.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" className="rounded-full" onClick={() => setReloadKey((value) => value + 1)}>
          Reload
        </Button>
      </div>

      <div className="rounded-2xl bg-card shadow-island px-5 py-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Agent</span>
          <select
            value={filters.agentId}
            onChange={(event) => updateFilters({ agentId: event.target.value })}
            className="w-full bg-transparent border-0 border-b border-border/60 text-sm py-1 outline-none"
            aria-label="Filter by agent"
          >
            <option value="">All agents</option>
            {agentOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Source</span>
          <select
            value={filters.source}
            onChange={(event) => updateFilters({ source: traceSourceParam(event.target.value) })}
            className="w-full bg-transparent border-0 border-b border-border/60 text-sm py-1 outline-none font-mono"
            aria-label="Filter by source"
          >
            <option value="">All sources</option>
            {TRACE_SOURCES.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">From</span>
          <Input type="datetime-local" value={filters.from} onChange={(event) => updateFilters({ from: event.target.value })} aria-label="Traces from" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">To</span>
          <Input type="datetime-local" value={filters.to} onChange={(event) => updateFilters({ to: event.target.value })} aria-label="Traces to" />
        </label>
      </div>
      <div className="flex items-center justify-between px-1">
        <span className="text-xs text-muted-foreground">
          {loading ? "Loading traces…" : `${visible.length} trace${visible.length === 1 ? "" : "s"}`}
        </span>
        {filtersActive && (
          <button type="button" onClick={() => setParams({}, { replace: true })} className="text-xs text-muted-foreground hover:text-foreground">
            Clear filters
          </button>
        )}
      </div>
      {rangeError && <p className="text-sm text-destructive">{rangeError}</p>}

      <TracePullPanel
        agent={selectedAgent}
        onPulled={async () => {
          const next = await listTraceIndex(filters);
          setTraces(next);
          setLoadError(null);
        }}
      />

      {loadError && (
        <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 px-5 py-4 space-y-2">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button type="button" size="sm" variant="outline" className="rounded-full" onClick={() => setReloadKey((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
          {[...Array(4)].map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl bg-card shadow-island py-16 text-center px-5">
          <p className="text-sm text-muted-foreground">
            {loadError
              ? "The list could not be loaded."
              : filtersActive
                ? "No traces match these filters."
                : "No traces yet. Pull traces for an agent, or launch a run."}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl bg-card shadow-island overflow-hidden">
          {visible.map((trace) => {
            const agentName = agents.find((agent) => agent.agent_id === trace.agent_id)?.name ?? trace.agent_id;
            return (
              <Link
                key={trace.trace_id}
                to={`/traces/${encodeURIComponent(trace.trace_id)}`}
                className="flex items-center gap-3 px-5 py-3.5 border-b border-border/30 last:border-0 hover:bg-muted/30 transition-colors"
              >
                <TraceSourceBadge source={traceListSource(trace)} />
                <span className="font-mono text-xs text-muted-foreground/70 w-36 shrink-0 truncate">{trace.trace_id}</span>
                <span className="text-sm min-w-0 truncate flex-1">{agentName}</span>
                <span className="hidden sm:block font-mono text-xs text-muted-foreground/60 w-28 shrink-0 truncate">{trace.task_id}</span>
                <span className={cn("text-xs font-mono shrink-0", statusClass(trace.status))}>{trace.status}</span>
                <span className="hidden md:block font-mono text-xs text-muted-foreground/50 shrink-0">{formatStarted(trace.started_at)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
