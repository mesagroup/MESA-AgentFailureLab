import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getTrace } from "@/lib/api";
import type { Trace, TraceStep, FaultLabel, FixKind } from "@mesa/shared";

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtCost(usd: number) {
  if (usd === 0) return "$0";
  return usd < 0.001 ? `$${(usd * 1000).toFixed(2)}m` : `$${usd.toFixed(4)}`;
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
  const labels: Record<FixKind, string> = {
    controlled_retry: "controlled retry",
    pre_response_check: "pre-response check",
    permission_guard: "permission guard",
  };
  return (
    <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono bg-blue-500/10 text-blue-400 border-blue-500/20">
      {labels[fix]}
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

function StepRow({ step, culpritIds }: { step: TraceStep; culpritIds: Set<string> }) {
  const [expanded, setExpanded] = useState(false);
  const isCulprit = culpritIds.has(step.step_id);
  const hasContent = !!step.content;
  const isExpandable = hasContent && (step.content?.length ?? 0) > 120;

  return (
    <div
      className={cn(
        "relative flex gap-3 px-5 py-3.5 border-b border-border/30 last:border-0",
        isCulprit && "bg-amber-500/5 border-l-2 border-l-amber-400 pl-[18px]"
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
            <span className="text-xs font-mono text-amber-500 font-medium">culprit</span>
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
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    getTrace(runId)
      .then(setTrace)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load trace"))
      .finally(() => setLoading(false));
  }, [runId]);

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

  const failedChecks = trace.outcome.verifier.checks.filter((c) => !c.passed);

  return (
    <div className="px-5 pb-8 max-w-6xl mx-auto space-y-4">

      {/* Back + header */}
      <div className="flex items-center gap-3 pt-2 pb-1">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-sm font-mono font-medium truncate">{trace.trace_id}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {trace.agent_id} · {trace.task_id}
          </p>
        </div>
      </div>

      {/* Fault banner */}
      {trace.fault.injected && trace.fault.labels.length > 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/8 px-4 py-2.5 flex items-center gap-3">
          <span className="text-xs text-amber-500 font-medium">Fault injected</span>
          <FaultCategoryBadge category={trace.fault.labels[0].category} />
          <span className="text-xs font-mono text-amber-500/70">{trace.fault.labels[0].code}</span>
        </div>
      )}

      {/* Verifier failure banner */}
      {!trace.outcome.verifier.passed && failedChecks.length > 0 && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-2.5 space-y-1">
          <span className="text-xs text-red-400 font-medium">Verifier failed</span>
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
              <StepRow key={step.step_id} step={step} culpritIds={culpritIds} />
            ))}
          </div>
        </div>

        {/* Right: diagnosis + verifier */}
        <div className="space-y-4">

          {/* Diagnosis */}
          {trace.diagnosis && (
            <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">Diagnosis</span>
                <span className="text-xs font-mono text-muted-foreground">
                  {Math.round(trace.diagnosis.confidence * 100)}% confidence
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <FaultCategoryBadge category={trace.diagnosis.category} />
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
            </div>
          )}

          {/* Verifier outcome */}
          <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Verifier</span>
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
