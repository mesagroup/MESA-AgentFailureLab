import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { Agent, Trace } from "@mesa/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { importTrace, listAgents, listTraceIndex } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { tracesIndexEmptyCopy } from "@/lib/trace-analysis";
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

function TraceImportPanel({ onImported }: { onImported?: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setJson("");
    setError(null);
    setWarn(null);
    setSubmitting(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleClose() {
    reset();
    setOpen(false);
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setJson((e.target?.result as string) ?? "");
      setError(null);
      setWarn(null);
    };
    reader.readAsText(file);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setWarn(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      setError("Invalid JSON");
      return;
    }

    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const fault = record.fault as Record<string, unknown> | undefined;
      if (fault) {
        const labels = Array.isArray(fault.labels) ? fault.labels : [];
        if (fault.injected === true || labels.length > 0) {
          setWarn("This trace has fault.injected true or fault.labels set — the server will reject it as a production trace.");
        }
      }
    }

    setSubmitting(true);
    try {
      const trace = await importTrace(parsed);
      onImported?.();
      await navigate(`/traces/${encodeURIComponent(trace.trace_id)}`);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          const body = err.body as Record<string, unknown> | null;
          const traceId = typeof body?.trace_id === "string" ? body.trace_id : null;
          if (traceId) {
            setError("This trace is already imported. Opening it…");
            setTimeout(() => void navigate(`/traces/${encodeURIComponent(traceId)}`), 800);
          } else {
            setError("This trace is already imported.");
          }
        } else if (err.status === 413) {
          setError("File too large (max 1 MiB)");
        } else if (err.status === 400) {
          const body = err.body as Record<string, unknown> | null;
          const errors = Array.isArray(body?.errors) ? (body.errors as string[]) : null;
          setError(errors ? errors.join("\n") : err.message);
        } else {
          setError(err.message);
        }
      } else {
        setError("Unexpected error. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-2xl bg-card shadow-island px-5 py-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Import trace</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Paste or upload a production Trace JSON to store it in the lab.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="rounded-full"
          variant={open ? "outline" : "default"}
          onClick={() => { if (open) { handleClose(); } else { setOpen(true); } }}
        >
          {open ? "Cancel" : "Import trace"}
        </Button>
      </div>

      {open && (
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Upload .json file</span>
            <input
              ref={fileRef}
              type="file"
              accept=".json"
              onChange={handleFileChange}
              className="block text-sm text-muted-foreground file:mr-3 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-medium file:bg-muted file:text-foreground hover:file:bg-muted/80"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Or paste JSON</span>
            <textarea
              value={json}
              onChange={(e) => { setJson(e.target.value); setError(null); setWarn(null); }}
              placeholder="Paste a production Trace JSON…"
              rows={8}
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-xs font-mono resize-y outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
            />
          </label>
          <div aria-live="polite" className="space-y-1">
            {warn && <p className="text-xs text-amber-500">{warn}</p>}
            {error && (
              <p className="text-sm text-destructive whitespace-pre-wrap">{error}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="rounded-full" disabled={submitting || !json.trim()}>
              {submitting ? "Importing…" : "Import"}
            </Button>
            <Button type="button" size="sm" variant="outline" className="rounded-full" onClick={handleClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
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

      <TraceImportPanel onImported={() => setReloadKey((value) => value + 1)} />

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
            {tracesIndexEmptyCopy(loadError ? "error" : filtersActive ? "filtered" : "none")}
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
