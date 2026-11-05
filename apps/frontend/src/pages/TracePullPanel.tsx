import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Agent } from "@mesa/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getOtelPullCursors, pullAgentTraces } from "@/lib/api";
import {
  TRACE_PULL_CHANNELS,
  describePullFailure,
  describeTraceListFailure,
  formatCursor,
  formatPullError,
  pullResultSummary,
  tracePullBody,
  type OtelPullCursors,
  type OtelPullResponse,
  type PullFailureView,
  type TracePullChannel,
} from "@/lib/traces";

export function TracePullPanel({
  agent,
  onPulled,
}: {
  agent: Agent | null;
  /** Reload `GET /traces` after a parsed pull. */
  onPulled?: (result: OtelPullResponse) => Promise<void>;
}) {
  const [channels, setChannels] = useState<Record<TracePullChannel, boolean>>({ prod: true, test: true });
  const [since, setSince] = useState("");
  const [pulling, setPulling] = useState(false);
  const [cursors, setCursors] = useState<OtelPullCursors | null>(null);
  const [cursorError, setCursorError] = useState<string | null>(null);
  const [result, setResult] = useState<OtelPullResponse | null>(null);
  const [failure, setFailure] = useState<PullFailureView | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  useEffect(() => {
    setChannels({ prod: true, test: true });
    setSince("");
    setResult(null);
    setFailure(null);
    setRefreshNote(null);
    setPulling(false);
    setCursors(null);
    setCursorError(null);
    if (!agent) return;
    let cancelled = false;
    getOtelPullCursors(agent.agent_id)
      .then((next) => {
        if (!cancelled) setCursors(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setCursorError(describeTraceListFailure(error));
      });
    return () => {
      cancelled = true;
    };
  }, [agent?.agent_id]);

  async function reloadCursors(agentId: string) {
    const next = await getOtelPullCursors(agentId);
    setCursors(next);
    setCursorError(null);
  }

  async function handlePull() {
    if (!agent) return;
    const selected = TRACE_PULL_CHANNELS.filter((channel) => channels[channel]);
    const built = tracePullBody({ sources: selected, since });
    if (!built.ok) {
      setResult(null);
      setRefreshNote(null);
      setFailure({ message: built.message, details: null });
      return;
    }
    setPulling(true);
    setResult(null);
    setFailure(null);
    setRefreshNote(null);
    try {
      const next = await pullAgentTraces(agent.agent_id, built.body);
      setResult(next);
      try {
        await reloadCursors(agent.agent_id);
      } catch (error) {
        setCursorError(describeTraceListFailure(error));
      }
      if (onPulled) {
        try {
          await onPulled(next);
          setRefreshNote("The list was reloaded from the lab.");
        } catch (error) {
          setRefreshNote(`Pull finished, but the list could not be reloaded. ${describeTraceListFailure(error)}`);
        }
      }
    } catch (error) {
      setFailure(describePullFailure(error));
    } finally {
      setPulling(false);
    }
  }

  return (
    <section className="rounded-2xl bg-card shadow-island px-5 py-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="pull-telemetry" className="text-sm font-semibold">Pull traces</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Fetches this agent's prod and test telemetry, then reloads the list. Leave the start time blank. The first pull fetches the full seed. A later pull uses the stored cursor.
          </p>
        </div>
        <Button type="button" size="sm" className="rounded-full" disabled={!agent || pulling} onClick={() => void handlePull()}>
          {pulling ? "Pulling…" : "Pull traces"}
        </Button>
      </div>

      {!agent ? (
        <p className="text-sm text-muted-foreground">Select an agent to pull traces.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs font-mono text-muted-foreground">
            {agent.name} · {agent.agent_id}
          </p>
          {agent.otel ? (
            <div className="space-y-1 text-xs font-mono text-muted-foreground break-all">
              <p>prod {agent.otel.prod.endpoint}</p>
              <p>test {agent.otel.test.endpoint}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              This agent has no prod or test traces URL. Register an OTel source before pulling.
            </p>
          )}
          <div className="text-xs font-mono text-muted-foreground space-y-0.5">
            {cursorError ? (
              <p className="text-destructive">{cursorError}</p>
            ) : cursors ? (
              <>
                <p>prod last pull: {formatCursor(cursors.prod.last_pull_at)}</p>
                <p>test last pull: {formatCursor(cursors.test.last_pull_at)}</p>
              </>
            ) : (
              <p>Loading cursors…</p>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-6">
            <fieldset className="space-y-1">
              <legend className="text-xs text-muted-foreground">Sources</legend>
              <div className="flex gap-3">
                {TRACE_PULL_CHANNELS.map((channel) => (
                  <label key={channel} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={channels[channel]} onChange={() => setChannels((current) => ({ ...current, [channel]: !current[channel] }))} />
                    {channel}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Stored rows are tagged otel_prod and otel_test.</p>
            </fieldset>
            <label className="space-y-1 min-w-[220px] flex-1">
              <span className="text-xs text-muted-foreground">Since override</span>
              <Input
                type="datetime-local"
                value={since}
                onChange={(event) => setSince(event.target.value)}
                aria-label="Override pull since"
              />
            </label>
          </div>
        </div>
      )}

      <div aria-live="polite" className="space-y-2">
        {pulling && (
          <p className="text-sm text-muted-foreground flex items-center gap-2" role="status">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
            Pulling traces…
          </p>
        )}
        {failure && (
          <div role="alert" className="text-sm text-destructive space-y-1">
            <p>{failure.message}</p>
            {failure.details && <p className="font-mono text-xs">{failure.details}</p>}
          </div>
        )}
        {result && (
          <div className="space-y-2">
            <p className="text-sm">{pullResultSummary(result)}</p>
            <ul className="space-y-2">
              {result.sources.map((source) => (
                <li key={source.source} className="text-sm">
                  <p className="font-mono text-xs text-muted-foreground">
                    {source.source} · {source.tag} · {source.transport}
                    {source.empty ? " · empty window" : ""}
                  </p>
                  <p>{source.message}</p>
                  <p className="text-xs text-muted-foreground">
                    Imported {source.imported}. Skipped {source.skipped}. Failed {source.failed}.
                    {source.last_pull_at ? ` Cursor ${source.last_pull_at}.` : " Cursor unchanged."}
                  </p>
                </li>
              ))}
            </ul>
            {result.errors.length > 0 && (
              <ul className="space-y-1">
                {result.errors.map((error, index) => (
                  <li key={`${error.source}-${error.kind}-${index}`} className="text-sm text-destructive">
                    {formatPullError(error)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {refreshNote && <p className="text-xs text-muted-foreground">{refreshNote}</p>}
        {result && agent && (
          <Link to={`/traces?agent=${encodeURIComponent(agent.agent_id)}`} className="text-sm underline-offset-2 hover:underline">
            View traces for this agent
          </Link>
        )}
      </div>
    </section>
  );
}
