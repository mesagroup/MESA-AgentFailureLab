import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { VerifierChecks } from "@/components/run/VerifierChecks";
import { getAgent, getRun, getTrace } from "@/lib/api";
import {
  decodeRunIdParam,
  loadRunDetail,
  shouldPollRun,
  type RunDetailLoad,
  type RunDetailView,
} from "@/lib/run-detail";
import { RUN_PHASE_LABELS } from "@/lib/run-launch";
import { SECURITY_BADGE_LABEL, SECURITY_RUNS_HREF, isSecurityRun } from "@/lib/security-runs";
import { cn } from "@/lib/utils";
import type { RunPhase, RunStatus } from "@mesa/shared";

const PHASE_STYLES: Record<RunPhase, string> = {
  baseline: "bg-blue-500/15 text-blue-500 border-blue-500/20",
  injected: "bg-amber-500/15 text-amber-500 border-amber-500/20",
  after_fix: "bg-emerald-500/15 text-emerald-500 border-emerald-500/20",
};

const STATUS_STYLES: Record<RunStatus, string> = {
  queued: "text-muted-foreground",
  running: "text-blue-500",
  passed: "text-green-600",
  failed: "text-red-500",
  error: "text-red-500",
};

function formatClock(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", { hour12: false });
}

function bannerClass(kind: RunDetailView["banners"][number]["kind"]): string {
  if (kind === "running" || kind === "queued") return "border-blue-500/20 bg-blue-500/10 text-blue-600";
  if (kind === "failed") return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "border-red-500/20 bg-red-500/10 text-red-600";
}

export function RunDetailPage() {
  const { runId: rawRunId } = useParams<{ runId: string }>();
  const runId = decodeRunIdParam(rawRunId);
  const [load, setLoad] = useState<RunDetailLoad | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const next = await loadRunDetail(runId, { getRun, getAgent, getTrace });
      if (!cancelled) setLoad(next);
    }
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    if (load?.status !== "ok" || !shouldPollRun(load.view.run)) return;
    const timer = setInterval(() => {
      void loadRunDetail(runId, { getRun, getAgent, getTrace }).then(setLoad);
    }, 3000);
    return () => clearInterval(timer);
  }, [load, runId]);

  if (!load) {
    return (
      <div className="px-5 pb-8 pt-2 max-w-5xl mx-auto space-y-4">
        <Skeleton className="h-6 w-48 mt-2" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    );
  }

  if (load.status !== "ok") {
    return (
      <div className="px-5 pb-8 pt-2 max-w-5xl mx-auto space-y-4">
        <BackToRuns />
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5 space-y-2">
          <h1 className="text-lg font-semibold">Run could not be opened</h1>
          <p className="font-mono text-xs text-muted-foreground break-all">{load.runId || "—"}</p>
          <p className="text-sm">{load.message}</p>
          {load.status === "error" && load.httpStatus != null && (
            <p className="text-xs text-muted-foreground">HTTP {load.httpStatus} from GET /runs/:runId</p>
          )}
        </div>
      </div>
    );
  }

  const { view } = load;
  const { run } = view;

  return (
    <div className="px-5 pb-8 pt-2 max-w-5xl mx-auto space-y-4">
      <BackToRuns security={isSecurityRun(run)} />

      <header className="rounded-2xl bg-card shadow-island p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs", PHASE_STYLES[run.phase])}>
            {RUN_PHASE_LABELS[run.phase]}
          </span>
          {isSecurityRun(run) && (
            <span className="inline-flex items-center rounded-md border border-violet-500/20 bg-violet-500/15 px-2 py-0.5 text-xs font-mono text-violet-500">
              {SECURITY_BADGE_LABEL}
            </span>
          )}
          <span className={cn("text-xs font-mono", STATUS_STYLES[run.status])}>{run.status}</span>
        </div>
        <div>
          <h1 className="text-xl font-semibold">{view.agent_name}</h1>
          <p className="text-sm text-muted-foreground mt-0.5 font-mono">{run.agent_id}</p>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Started</dt>
            <dd className="font-mono text-xs mt-0.5">{formatClock(view.started_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Ended</dt>
            <dd className="font-mono text-xs mt-0.5">{formatClock(view.ended_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Duration</dt>
            <dd className="font-mono text-xs mt-0.5">
              {run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(2)}s` : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Parent run</dt>
            <dd className="font-mono text-xs mt-0.5 break-all">{run.parent_run_id ?? "—"}</dd>
          </div>
        </dl>
      </header>

      {view.banners.map((banner) => (
        <div key={`${banner.kind}-${banner.message}`} className={cn("rounded-2xl border px-4 py-3 text-sm", bannerClass(banner.kind))}>
          {banner.message}
        </div>
      ))}

      <VerifierChecks verifier={view.verifier} empty={view.verifier_empty} />

      <section className="rounded-2xl bg-card shadow-island p-5 space-y-4">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-xs font-semibold bg-muted px-2 py-0.5 rounded">
            {view.task.task_id}
          </span>
          <h2 className="text-sm font-semibold">{view.task.title}</h2>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Prompt</p>
          {view.task.prompt ? (
            <pre className="text-sm whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 leading-relaxed">
              {view.task.prompt}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">No prompt is stored on the agent task for this run.</p>
          )}
        </div>

        {view.task.setup_summary && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Setup</p>
            <p className="text-xs text-muted-foreground">{view.task.setup_summary}</p>
          </div>
        )}
      </section>

      {view.notes && (
        <section className="rounded-2xl bg-card shadow-island p-5 space-y-2">
          <h2 className="text-sm font-semibold">{view.notes.title}</h2>
          <p className="text-sm leading-relaxed">{view.notes.body}</p>
          <p className="text-xs text-muted-foreground">This note is not the verifier. outcome.verifier stays the pass/fail source.</p>
        </section>
      )}

      <section className="rounded-2xl bg-card shadow-island p-5 space-y-2">
        <h2 className="text-sm font-semibold">Trace</h2>
        {view.trace_href ? (
          <div className="flex flex-wrap gap-4">
            <Link to={view.trace_href} className="text-sm underline-offset-2 hover:underline">
              Open full trace
            </Link>
            {view.analyze_href && (
              <Link to={view.analyze_href} className="text-sm underline-offset-2 hover:underline">
                Analyze trace
              </Link>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{view.trace_empty ?? "No trace is stored for this run."}</p>
        )}
        {view.trace_href && view.trace_empty && (
          <p className="text-xs text-muted-foreground">{view.trace_empty}</p>
        )}
      </section>
    </div>
  );
}

function BackToRuns({ security }: { security?: boolean }) {
  return (
    <Link to={security ? SECURITY_RUNS_HREF : "/runs"} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" />
      Runs
    </Link>
  );
}
