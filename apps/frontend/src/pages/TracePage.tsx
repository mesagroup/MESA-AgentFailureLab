import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ApiError, createRun, diagnoseTrace, getAgent, getHarnessSnapshot, getRun, getTrace, type HarnessSnapshot } from "@/lib/api";
import {
  AFTER_FIX_SECTION_ID,
  FIX_KIND_LABELS,
  afterFixRunBody,
  childRunsOf,
  firstTraceId,
  formatCostUsd,
  selectableFixKinds,
  toggleFixKind,
  type HarnessTaskResult,
} from "@/lib/after-fix";
import { isWorldBusy } from "@/lib/jury";
import { adrFixForCategory, type Agent, type FixKind, type Run, type Trace, type TraceStep, type FaultLabel } from "@mesa/shared";
import { AfterFixPanel } from "@/pages/AfterFixPanel";
import { TraceSourceBadge } from "@/pages/TraceSourceBadge";
import { ANALYSIS_SECTION_ID, describeDiagnoseFailure, parentRunHref, TRACE_LIST_ROUTE } from "@/lib/trace-analysis";
import { traceListSource } from "@/lib/traces";

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtCost(usd: number) {
  return formatCostUsd(usd);
}

function StatusBadge({ status }: { status: Trace["status"] }) {
  const styles: Record<Trace["status"], string> = {
    completed: "bg-green-500/15 text-green-500 border-green-500/20",
    failed: "bg-red-500/15 text-red-400 border-red-500/20",
    timeout: "bg-amber-500/15 text-amber-400 border-amber-500/20",
    error: "bg-red-500/15 text-red-400 border-red-500/20",
  };
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono", styles[status])}>
      {status}
    </span>
  );
}

function FaultCategoryBadge({ category }: { category: string }) {
  return (
    <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono bg-amber-500/10 text-amber-500 border-amber-500/20">
      {category}
    </span>
  );
}

function FixBadge({ fix }: { fix: FixKind }) {
  return (
    <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono bg-blue-500/10 text-blue-400 border-blue-500/20">
      {FIX_KIND_LABELS[fix]}
    </span>
  );
}

// ── step timeline ─────────────────────────────────────────────────────────────

const STEP_COLORS: Record<TraceStep["type"], string> = {
  message: "bg-blue-500",
  tool_call: "bg-amber-400",
  tool_result: "bg-green-500",
  system: "bg-zinc-400",
};

const STEP_LABEL_COLORS: Record<TraceStep["type"], string> = {
  message: "text-blue-400",
  tool_call: "text-amber-400",
  tool_result: "text-green-500",
  system: "text-zinc-400",
};

function CollapsibleJson({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  const preview = JSON.stringify(value);
  const short = preview.length > 60 ? preview.slice(0, 60) + "…" : preview;
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {open ? "hide" : short}
      </button>
      {open && (
        <pre className="mt-1.5 text-xs font-mono bg-muted/40 rounded-lg p-3 overflow-x-auto text-muted-foreground leading-relaxed">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function StepRow({ step, culpritIds, diagnosisStepIds }: { step: TraceStep; culpritIds: Set<string>; diagnosisStepIds: Set<string> }) {
  const [expanded, setExpanded] = useState(false);
  const isCulprit = culpritIds.has(step.step_id);
  const isDiagnosis = !isCulprit && diagnosisStepIds.has(step.step_id);
  const hasContent = !!step.content;
  const isExpandable = hasContent && (step.content?.length ?? 0) > 120;

  return (
    <div
      className={cn(
        "relative flex gap-3 px-5 py-3.5 border-b border-border/30 last:border-0",
        isCulprit && "bg-amber-500/5 border-l-2 border-l-amber-400 pl-[18px]",
        isDiagnosis && "bg-indigo-500/5 border-l-2 border-l-indigo-400 pl-[18px]"
      )}
    >
      {/* Type dot */}
      <div className="flex flex-col items-center pt-1 shrink-0">
        <span className={cn("h-2 w-2 rounded-full shrink-0", STEP_COLORS[step.type])} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn("text-xs font-mono font-medium", STEP_LABEL_COLORS[step.type])}>
            {step.type.replace("_", " ")}
          </span>
          <span className="text-xs text-muted-foreground/60 font-mono">{step.role}</span>
          {step.tool_name && (
            <span className="text-xs font-mono bg-muted/60 px-1.5 py-0.5 rounded">{step.tool_name}</span>
          )}
          {isCulprit && (
            <span className="text-xs font-mono text-amber-500 font-medium">Failing step</span>
          )}
          {isDiagnosis && (
            <span className="text-xs font-mono text-indigo-400 font-medium">diagnosis</span>
          )}
          <span className="text-xs font-mono text-muted-foreground/40 ml-auto">{fmt(step.timestamp)}</span>
        </div>

        {/* Message content */}
        {hasContent && (
          <div className="mt-1.5">
            <p
              className={cn("text-sm text-foreground/80 leading-relaxed", !expanded && "line-clamp-3")}
            >
              {step.content}
            </p>
            {isExpandable && (
              <button
                onClick={() => setExpanded((e) => !e)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}

        {/* Tool input/output */}
        {step.tool_input !== undefined && step.type === "tool_call" && (
          <div className="mt-1">
            <span className="text-xs text-muted-foreground/60">input</span>
            <CollapsibleJson value={step.tool_input} />
          </div>
        )}
        {step.tool_output !== undefined && step.type === "tool_result" && (
          <div className="mt-1">
            <span className="text-xs text-muted-foreground/60">output</span>
            <CollapsibleJson value={step.tool_output} />
          </div>
        )}
      </div>

      {/* Metrics */}
      <div className="shrink-0 text-right space-y-0.5 pt-0.5">
        <p className="text-xs font-mono text-muted-foreground/50">{step.latency_ms}ms</p>
        {step.cost_usd > 0 && (
          <p className="text-xs font-mono text-muted-foreground/40">{fmtCost(step.cost_usd)}</p>
        )}
      </div>
    </div>
  );
}

// ── loading skeleton ──────────────────────────────────────────────────────────

function TraceSkeleton() {
  return (
    <div className="px-5 pb-8 max-w-6xl mx-auto space-y-4">
      <Skeleton className="h-6 w-48 mt-4" />
      <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="rounded-2xl bg-card shadow-island overflow-hidden">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex gap-3 px-5 py-3.5 border-b border-border/30 last:border-0">
            <Skeleton className="h-2 w-2 rounded-full mt-1 shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-4 w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export function TracePage() {
  const { traceId } = useParams<{ traceId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [snapshot, setSnapshot] = useState<HarnessSnapshot | null>(null);
  const [extraTraces, setExtraTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFixes, setSelectedFixes] = useState<FixKind[]>([]);
  const [replayPending, setReplayPending] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [cleanTreated, setCleanTreated] = useState(false);
  const [replayPair, setReplayPair] = useState<HarnessTaskResult | null>(null);
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [issueFeedback, setIssueFeedback] = useState<string | null>(null);
  const [diagnosePending, setDiagnosePending] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
  const afterParam = searchParams.get("after");

  async function load(id: string, silent = false) {
    if (!silent) {
      setLoading(true);
      setReplayPair(null);
    }
    setError(null);
    try {
      const [nextTrace, nextSnapshot] = await Promise.all([getTrace(id), getHarnessSnapshot().catch(() => null)]);
      const merged = await mergeRunSnapshot(nextTrace, nextSnapshot);
      setTrace(nextTrace);
      setSnapshot(merged.snapshot);
      setExtraTraces(merged.traces);
      if (!silent) setSelectedFixes(selectableFixKinds(nextTrace.diagnosis?.proposed_fixes));
      const nextAgent = await getAgent(nextTrace.agent_id);
      setAgent(nextAgent ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load trace");
      setTrace(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    if (!traceId) { setLoading(false); return; }
    void load(traceId);
  }, [traceId]);

  useEffect(() => {
    if (loading || !trace) return;
    if (window.location.hash !== `#${ANALYSIS_SECTION_ID}`) return;
    document.getElementById(ANALYSIS_SECTION_ID)?.scrollIntoView({ block: "start" });
  }, [loading, trace]);

  const runs = snapshot?.runs ?? [];
  const proposed = selectableFixKinds(trace?.diagnosis?.proposed_fixes);
  const currentRun = trace ? runs.find((item) => item.run_id === trace.run_id) ?? null : null;
  const parentRunId = currentRun?.parent_run_id ?? (currentRun && currentRun.phase !== "after_fix" ? currentRun.run_id : null);
  const parentRun = parentRunId ? runs.find((item) => item.run_id === parentRunId) ?? currentRun : currentRun;
  const lineageParentId = currentRun?.phase === "after_fix"
    ? (currentRun.parent_run_id ?? parentRunId)
    : (currentRun?.run_id ?? trace?.run_id ?? null);
  const linkForCurrent = snapshot?.trace_links.find((item) => item.run_id === currentRun?.run_id);
  const linkForParent = snapshot?.trace_links.find((item) => item.run_id === lineageParentId);
  const childIds = (currentRun?.phase === "after_fix" ? linkForParent?.child_run_ids : linkForCurrent?.child_run_ids) ?? [];
  const childRuns = childIds.length
    ? childIds.map((id) => runs.find((item) => item.run_id === id)).filter((item): item is Run => Boolean(item))
    : (lineageParentId ? childRunsOf(runs, lineageParentId) : []);
  const afterChild = afterParam
    ? childRuns.find((item) => item.trace_ids.includes(afterParam) || item.run_id === afterParam)
    : undefined;
  const preferredChild = replayPair?.run
    ?? afterChild
    ?? (currentRun?.phase === "after_fix" ? currentRun : childRuns[0] ?? null);
  const parentTraceView = replayPair?.parent?.trace
    ? { trace_id: replayPair.parent.trace.trace_id, outcome: replayPair.parent.trace.outcome, totals: replayPair.parent.trace.totals }
    : parentTraceFrom(trace, parentRun, snapshot, extraTraces);
  const childTraceView = replayPair?.trace
    ? { trace_id: replayPair.trace.trace_id, outcome: replayPair.trace.outcome, totals: replayPair.trace.totals }
    : childTraceFrom(trace, preferredChild, snapshot, afterParam, extraTraces);

  async function replayAfterFix() {
    if (!trace) return;
    const parentId = currentRun?.phase === "after_fix"
      ? (currentRun.parent_run_id ?? trace.run_id)
      : (currentRun?.run_id ?? trace.run_id);
    const built = afterFixRunBody({
      agentId: trace.agent_id,
      parentRunId: parentId,
      fixKinds: selectedFixes,
      cleanTreated,
    });
    if (!built.ok) {
      setReplayError(built.message);
      setReplayBusy(false);
      return;
    }
    setReplayPending(true);
    setReplayError(null);
    setReplayBusy(false);
    try {
      const results = await createRun(built.body);
      const child = results[0] ?? null;
      setReplayPair(child);
      const afterId = child?.trace?.trace_id ?? firstTraceId(child?.run ?? null);
      if (afterId) setSearchParams({ after: afterId });
      await load(trace.trace_id, true);
      requestAnimationFrame(() => {
        document.getElementById(AFTER_FIX_SECTION_ID)?.scrollIntoView({ block: "start" });
      });
    } catch (e) {
      setReplayBusy(isWorldBusy(e, e instanceof ApiError ? e.code : null));
      setReplayError(e instanceof Error ? e.message : "Replay failed.");
    } finally {
      setReplayPending(false);
    }
  }

  async function runDiagnosis() {
    if (!trace) return;
    setDiagnosePending(true);
    setDiagnoseError(null);
    try {
      const next = await diagnoseTrace(trace.trace_id);
      setTrace(next);
      setSelectedFixes(selectableFixKinds(next.diagnosis?.proposed_fixes));
    } catch (e) {
      setDiagnoseError(describeDiagnoseFailure(e));
    } finally {
      setDiagnosePending(false);
    }
  }

  if (!traceId) {
    return (
      <div className="px-5 pb-8 max-w-6xl mx-auto pt-2">
        <h1 className="text-xl font-semibold">Traces</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Open a run to inspect its stored trace.
        </p>
        <Link to={TRACE_LIST_ROUTE} className="text-sm underline-offset-2 hover:underline mt-3 inline-block">
          All traces
        </Link>
      </div>
    );
  }

  if (loading) return <TraceSkeleton />;

  if (error || !trace) {
    return (
      <div className="px-5 pb-8 max-w-6xl mx-auto pt-8 text-center space-y-3">
        <p className="text-sm text-muted-foreground">
          {error ?? "Trace not found."}
        </p>
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
          Back
        </Button>
      </div>
    );
  }

  const culpritIds = new Set<string>(
    trace.fault.labels.map((l: FaultLabel) => l.step_id).filter(Boolean)
  );

  const diagnosisStepIds = new Set<string>(
    trace.diagnosis?.step_id && !culpritIds.has(trace.diagnosis.step_id)
      ? [trace.diagnosis.step_id]
      : []
  );

  const failedChecks = trace.outcome.verifier.checks.filter((c) => !c.passed);
  const runLink = parentRunHref(trace.run_id);

  return (
    <div className="px-5 pb-8 max-w-6xl mx-auto space-y-4">

      {/* Back + header */}
      <div className="flex items-center gap-3 pt-2 pb-1">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-sm font-mono font-medium truncate">{trace.trace_id}</h1>
            <TraceSourceBadge source={traceListSource(trace)} />
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {trace.agent_id} · {trace.task_id}
            {runLink && (
              <>
                {" · "}
                <Link to={runLink} className="underline-offset-2 hover:underline">
                  From run
                </Link>
              </>
            )}
            {" · "}
            <Link to={TRACE_LIST_ROUTE} className="underline-offset-2 hover:underline">
              All traces
            </Link>
          </p>
        </div>
      </div>

      {/* Fault banner */}
      {trace.fault.injected && trace.fault.labels.length > 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/8 px-4 py-2.5 flex items-center gap-3">
          <span className="text-xs text-amber-500 font-medium">Fault applied</span>
          <FaultCategoryBadge category={trace.fault.labels[0].category} />
          <span className="text-xs font-mono text-amber-500/70">{trace.fault.labels[0].code}</span>
        </div>
      )}

      {/* Verifier failure banner */}
      {!trace.outcome.verifier.passed && failedChecks.length > 0 && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-2.5 space-y-1">
          <span className="text-xs text-red-400 font-medium">Checks failed</span>
          <ul className="space-y-0.5">
            {failedChecks.map((c) => (
              <li key={c.name} className="text-xs font-mono text-red-400/70">
                {c.name} — {c.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">

        {/* Left: summary + timeline */}
        <div className="space-y-4">

          {/* Trace summary */}
          <div className="rounded-2xl bg-card shadow-island p-5">
            <div className="flex items-center gap-3 flex-wrap mb-3">
              <StatusBadge status={trace.status} />
              <span className="text-xs font-mono text-muted-foreground">
                {fmt(trace.started_at)} → {fmt(trace.ended_at)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
              <Metric label="Latency" value={`${(trace.totals.latency_ms / 1000).toFixed(2)}s`} />
              <Metric label="Cost" value={fmtCost(trace.totals.cost_usd)} />
              <Metric label="Tokens in" value={trace.totals.tokens_in.toLocaleString()} />
              <Metric label="Tokens out" value={trace.totals.tokens_out.toLocaleString()} />
            </div>
          </div>

          {/* Step timeline */}
          <div className="rounded-2xl bg-card shadow-island overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border/40">
              <span className="text-xs font-medium">Steps</span>
              <span className="text-xs text-muted-foreground">{trace.steps.length}</span>
            </div>
            {trace.steps.map((step) => (
              <StepRow key={step.step_id} step={step} culpritIds={culpritIds} diagnosisStepIds={diagnosisStepIds} />
            ))}
          </div>
        </div>

        {/* Right: diagnosis + verifier */}
        <div className="space-y-4">

          {/* Analysis / Diagnosis — always visible; CTA when diagnosis is absent */}
          <div id={ANALYSIS_SECTION_ID} className="rounded-2xl bg-card shadow-island p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Analysis</span>
              {trace.diagnosis && (
                <span className="text-xs font-mono text-muted-foreground">
                  {Math.round(trace.diagnosis.confidence * 100)}% confidence
                </span>
              )}
            </div>
            {trace.diagnosis ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <FaultCategoryBadge category={trace.diagnosis.category} />
                  <span className="text-xs font-mono text-muted-foreground">
                    Failing step {trace.diagnosis.step_id}
                  </span>
                </div>
                <p className="text-xs text-foreground/80 leading-relaxed">{trace.diagnosis.cause}</p>
                {trace.diagnosis.evidence.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">Evidence</p>
                    <ul className="space-y-1">
                      {trace.diagnosis.evidence.map((e, i) => (
                        <li key={i} className="text-xs text-muted-foreground font-mono leading-relaxed">
                          — {e}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {trace.diagnosis.proposed_fixes.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">Proposed fixes</p>
                    <div className="flex flex-wrap gap-1.5">
                      {trace.diagnosis.proposed_fixes.map((fix) => (
                        <FixBadge key={fix} fix={fix} />
                      ))}
                    </div>
                  </div>
                )}
                <div className="pt-1">
                  {agent?.github_repo_url ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full text-xs"
                        onClick={() => { setIssueFeedback(null); setIssueDialogOpen(true); }}
                      >
                        Open as GitHub issue
                      </Button>
                      {issueFeedback && (
                        <p className="text-xs text-green-500 mt-1.5 text-center">{issueFeedback}</p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Configure a GitHub repo URL on the agent to use this feature.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Diagnosis not available</p>
                <Button
                  type="button"
                  size="sm"
                  className="w-full text-xs"
                  disabled={diagnosePending}
                  aria-busy={diagnosePending}
                  onClick={() => void runDiagnosis()}
                >
                  {diagnosePending ? "Running diagnosis…" : "Run diagnosis"}
                </Button>
                {diagnoseError && (
                  <p role="alert" className="text-xs text-destructive leading-relaxed">{diagnoseError}</p>
                )}
              </div>
            )}
          </div>

          {/* Verifier outcome */}
          <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Checks</span>
              <span className={cn(
                "text-xs font-mono",
                trace.outcome.verifier.passed ? "text-green-500" : "text-red-400"
              )}>
                {trace.outcome.verifier.passed ? "passed" : "failed"}
              </span>
            </div>
            <div className="space-y-2">
              {trace.outcome.verifier.checks.map((check) => (
                <div key={check.name} className="space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-mono">{check.name}</span>
                    <span className={cn(
                      "text-xs font-mono shrink-0",
                      check.passed ? "text-green-500" : "text-red-400"
                    )}>
                      {check.passed ? "✓" : "✗"}
                    </span>
                  </div>
                  {!check.passed && (
                    <p className="text-xs text-muted-foreground leading-relaxed">{check.detail}</p>
                  )}
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>

      {issueDialogOpen && trace.diagnosis && agent?.github_repo_url && (() => {
        const d = trace.diagnosis;
        const issueTitle = `[MESA] ${d.category}: ${trace.agent_id} — ${trace.task_id}`;
        const issueBody = [
          "## Fault diagnosis",
          "",
          `**Category:** ${d.category}`,
          `**Confidence:** ${Math.round(d.confidence * 100)}%`,
          `**Cause:** ${d.cause}`,
          "",
          "## Evidence",
          ...d.evidence.map((e) => `- ${e}`),
          "",
          "## Proposed fixes",
          ...d.proposed_fixes.map((f) => `- ${f}`),
          "",
          "## Trace",
          `Agent: ${trace.agent_id}`,
          `Task: ${trace.task_id}`,
          `Status: ${trace.status}`,
          `Trace ID: ${trace.trace_id}`,
          `Link: ${window.location.origin}/traces/${trace.trace_id}`,
        ].join("\n");
        const repoUrl = agent.github_repo_url.replace(/\/$/, "");
        const ghUrl = `${repoUrl}/issues/new?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent(issueBody)}`;
        return (
          <dialog
            open
            className="fixed inset-0 z-50 m-auto w-full max-w-lg rounded-2xl bg-card p-6 shadow-xl border border-border"
            onClick={(e) => { if (e.target === e.currentTarget) setIssueDialogOpen(false); }}
          >
            <h2 className="text-sm font-semibold mb-1">Open as GitHub issue</h2>
            <p className="text-xs text-muted-foreground mb-3">Review the composed issue before opening GitHub.</p>
            <div className="rounded-lg bg-muted/40 p-3 mb-4 max-h-64 overflow-y-auto">
              <p className="text-xs font-mono font-medium mb-2">{issueTitle}</p>
              <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed">{issueBody}</pre>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setIssueDialogOpen(false)}>Cancel</Button>
              <Button
                size="sm"
                onClick={() => {
                  window.open(ghUrl, "_blank", "noopener,noreferrer");
                  setIssueDialogOpen(false);
                  setIssueFeedback("Issue opened in new tab");
                }}
              >
                Open on GitHub
              </Button>
            </div>
          </dialog>
        );
      })()}

      <AfterFixPanel
        proposed={proposed}
        selected={selectedFixes}
        suggested={trace.diagnosis ? adrFixForCategory(trace.diagnosis.category) : undefined}
        onToggle={(kind) => setSelectedFixes((current) => toggleFixKind(current, kind))}
        onReplay={() => void replayAfterFix()}
        pending={replayPending}
        error={replayError}
        worldBusy={replayBusy}
        cleanTreated={cleanTreated}
        onCleanTreated={setCleanTreated}
        parentRun={replayPair?.parent?.run ?? parentRun}
        parentTrace={parentTraceView}
        childRun={preferredChild}
        childTrace={childTraceView}
        childRuns={childRuns}
        resultLinks={replayPair?.links ?? null}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-mono font-medium mt-0.5">{value}</p>
    </div>
  );
}

function linkedTrace(snapshot: HarnessSnapshot | null, run: Run | null, extras: Trace[]) {
  if (run) {
    const extra = extras.find((item) => item.run_id === run.run_id);
    if (extra) return { trace_id: extra.trace_id, outcome: extra.outcome, totals: extra.totals };
  }
  if (!snapshot || !run) return null;
  const link = snapshot.trace_links.find((item) => item.run_id === run.run_id);
  const row = link?.traces[0];
  if (row) return { trace_id: row.trace_id, outcome: row.outcome, totals: row.totals };
  return null;
}

function parentTraceFrom(
  trace: Trace | null,
  parentRun: Run | null,
  snapshot: HarnessSnapshot | null,
  extras: Trace[],
) {
  if (trace && parentRun && trace.run_id === parentRun.run_id) {
    return { trace_id: trace.trace_id, outcome: trace.outcome, totals: trace.totals };
  }
  return linkedTrace(snapshot, parentRun, extras);
}

function childTraceFrom(
  trace: Trace | null,
  childRun: Run | null,
  snapshot: HarnessSnapshot | null,
  afterParam: string | null,
  extras: Trace[],
) {
  if (trace && (trace.trace_id === afterParam || (childRun && trace.run_id === childRun.run_id))) {
    return { trace_id: trace.trace_id, outcome: trace.outcome, totals: trace.totals };
  }
  if (afterParam) {
    const extra = extras.find((item) => item.trace_id === afterParam);
    if (extra) return { trace_id: extra.trace_id, outcome: extra.outcome, totals: extra.totals };
  }
  return linkedTrace(snapshot, childRun, extras);
}

async function mergeRunSnapshot(
  trace: Trace,
  snapshot: HarnessSnapshot | null,
): Promise<{ snapshot: HarnessSnapshot | null; traces: Trace[] }> {
  const runs = [...(snapshot?.runs ?? [])];
  async function addRun(id: string | null | undefined) {
    if (!id || runs.some((item) => item.run_id === id)) return;
    try {
      runs.push(await getRun(id));
    } catch {
      // The run is not in this harness session.
    }
  }
  await addRun(trace.run_id);
  const current = runs.find((item) => item.run_id === trace.run_id);
  await addRun(current?.parent_run_id);
  const extras: Trace[] = [];
  const needed = new Set<string>();
  for (const run of runs) {
    const first = firstTraceId(run);
    if (first && first !== trace.trace_id) needed.add(first);
  }
  await Promise.all(
    [...needed].map(async (id) => {
      try {
        extras.push(await getTrace(id));
      } catch {
        // Linked trace is missing from the store.
      }
    }),
  );
  if (!snapshot && runs.length === 0) return { snapshot: null, traces: extras };
  return {
    snapshot: {
      runs,
      trace_links: snapshot?.trace_links ?? [],
      counts: snapshot?.counts ?? {
        scope: "harness_session",
        agents: 0,
        runs: runs.length,
        queued: 0,
        running: 0,
        passed: 0,
        failed: 0,
        error: 0,
      },
    },
    traces: extras,
  };
}
