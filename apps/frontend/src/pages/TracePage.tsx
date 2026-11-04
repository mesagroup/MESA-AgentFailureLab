import { useEffect, useRef, useState, type RefObject } from "react";
import { Link, useParams } from "react-router-dom";
import { Activity, ChevronDown, ChevronRight, CornerDownLeft, Info, MessageSquare, Sparkles, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Agent, FixKind, StepType, Trace, TraceStep } from "@mesa/shared";
import { StatusBadge } from "@/components/badges";
import { CodeTip, CopyIdButton } from "@/components/CodeTip";
import { Page, PageHeader, SectionTitle } from "@/components/PageHeader";
import { ErrorState, StateCard } from "@/components/StateCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { diagnoseTrace, getAgent, getRun, getTrace } from "@/lib/api";
import { apiErrorDetails, friendlyApiMessage } from "@/lib/errors";
import {
  FIX_LABEL,
  STEP_ROLE_LABEL,
  STEP_TYPE_LABEL,
  categoryLabel,
  checkLabel,
  faultCodeLabel,
  formatClock,
  formatCost,
  formatDuration,
  formatRunLabel,
  formatTaskLabel,
  formatTraceTitle,
} from "@/lib/labels";
import { cn } from "@/lib/utils";

const STEP_ICON: Record<StepType, LucideIcon> = {
  message: MessageSquare,
  tool_call: Wrench,
  tool_result: CornerDownLeft,
  system: Info,
};

export function TracePage() {
  const { traceId } = useParams<{ traceId: string }>();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(Boolean(traceId));
  const [error, setError] = useState<unknown>(null);
  const [agentError, setAgentError] = useState<unknown>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState<unknown>(null);
  const [pollError, setPollError] = useState<unknown>(null);
  const culpritRef = useRef<HTMLDivElement>(null);

  const task = agent?.tasks.find((item) => item.task_id === trace?.task_id);
  const taskTitle = formatTaskLabel({ title: task?.title, task_id: trace?.task_id });
  const title = trace ? formatTraceTitle({ taskTitle, at: trace.started_at }) : "Traces";
  useDocumentTitle(trace ? title : traceId ? "Trace" : "Traces");

  async function load(id: string) {
    setLoading(true);
    setError(null);
    try {
      const next = await getTrace(id);
      setTrace(next);
      try {
        setAgent(await getAgent(next.agent_id));
        setAgentError(null);
      } catch (cause) {
        setAgent(null);
        setAgentError(cause);
      }
    } catch (cause) {
      setTrace(null);
      setError(cause);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!traceId) {
      setLoading(false);
      setTrace(null);
      return;
    }
    void load(traceId);
  }, [traceId]);

  useEffect(() => {
    if (!trace) return;
    const runId = trace.run_id;
    const id = trace.trace_id;
    let timer = 0;
    let cancelled = false;
    async function tick() {
      try {
        const run = await getRun(runId);
        if (cancelled) return;
        if (run.status !== "queued" && run.status !== "running") return;
        setTrace(await getTrace(id));
        timer = window.setTimeout(() => void tick(), 3000);
      } catch (cause) {
        if (!cancelled) setPollError(cause);
      }
    }
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trace?.trace_id, trace?.run_id]);

  const culpritIds = new Set(trace?.fault.labels.map((label) => label.step_id).filter(Boolean) ?? []);
  const firstCulprit = trace?.fault.labels[0]?.step_id;

  useEffect(() => {
    if (!firstCulprit) return;
    const handle = window.setTimeout(() => {
      culpritRef.current?.scrollIntoView({ block: "center" });
    }, 50);
    return () => window.clearTimeout(handle);
  }, [trace?.trace_id, firstCulprit]);

  if (!traceId) {
    return (
      <Page>
        <PageHeader title="Traces" subtitle="Open a run to inspect its trace." />
        <StateCard
          icon={Activity}
          title="No trace selected"
          description="Launch a test, then open the run to see the timeline."
          action={<Button size="sm" className="rounded-full" nativeButton={false} render={<Link to="/runs" />}>Go to runs</Button>}
        />
      </Page>
    );
  }

  if (loading) return <TraceSkeleton />;

  if (error || !trace) {
    return (
      <Page>
        <PageHeader title="Trace" subtitle="The trace could not be loaded." />
        <ErrorState error={error ?? new Error("Trace not found.")} onRetry={() => void load(traceId)} />
      </Page>
    );
  }

  const failedChecks = trace.outcome.verifier.checks.filter((check) => !check.passed);
  const disagree = trace.outcome.agent_claimed_success && !trace.outcome.verifier.passed;

  async function handleDiagnose() {
    setDiagnosing(true);
    setDiagnoseError(null);
    try {
      setTrace(await diagnoseTrace(trace!.trace_id));
    } catch (cause) {
      setDiagnoseError(cause);
    } finally {
      setDiagnosing(false);
    }
  }

  return (
    <Page>
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 pt-2 text-sm text-muted-foreground">
        <Link to={`/agents/${encodeURIComponent(trace.agent_id)}`} className="hover:text-foreground">
          {agent?.name ?? "Agent"}
        </Link>
        <span aria-hidden>/</span>
        <Link to={`/runs/${encodeURIComponent(trace.run_id)}`} className="hover:text-foreground">
          {formatRunLabel({ taskTitle, at: trace.started_at })}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-foreground">Trace</span>
      </nav>
      {agentError != null && <ErrorState error={agentError} onRetry={() => void load(trace.trace_id)} />}
      {pollError != null && <ErrorState error={pollError} onRetry={() => void load(trace.trace_id)} />}
      <PageHeader
        title={title}
        subtitle={agent?.name ?? "Trace"}
        actions={<CopyIdButton id={trace.trace_id} label="Copy trace id" />}
      />

      {disagree && (
        <div className="rounded-2xl border border-failed/30 bg-failed-soft px-4 py-3 text-sm font-medium text-failed">
          Agent claimed success · Verifier: failed
        </div>
      )}

      {trace.fault.labels.length > 0 && (
        <div className="rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">
          <p className="font-medium">Injected faults</p>
          <ul className="mt-2 space-y-1">
            {trace.fault.labels.map((label) => (
              <li key={`${label.step_id}-${label.code}`}>
                <a href={`#step-${label.step_id}`} title={label.code} className="font-medium underline-offset-2 hover:underline">
                  {faultCodeLabel(label.code)}
                </a>
                <span className="text-foreground/80"> · {categoryLabel(label.category)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!trace.outcome.verifier.passed && failedChecks.length > 0 && (
        <div className="rounded-2xl border border-failed/30 bg-failed-soft px-4 py-3 text-sm text-failed">
          <p className="font-medium">Verifier failed</p>
          <ul className="mt-2 space-y-1">
            {failedChecks.map((check) => (
              <li key={check.name}>
                <CodeTip label={checkLabel(check.name)} code={check.name} />
                <span> — {check.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <section className="rounded-2xl bg-card p-5 shadow-island">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <StatusBadge status={trace.status} />
              <span className="text-sm text-muted-foreground">
                {formatClock(trace.started_at)} – {formatClock(trace.ended_at)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Metric label="Time" value={formatDuration(trace.totals.latency_ms)} />
              <Metric label="Cost" value={formatCost(trace.totals.cost_usd)} />
              <Metric label="Tokens in" value={trace.totals.tokens_in.toLocaleString()} />
              <Metric label="Tokens out" value={trace.totals.tokens_out.toLocaleString()} />
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl bg-card shadow-island">
            <SectionTitle aside={<span className="text-xs text-muted-foreground">{trace.steps.length}</span>}>Timeline</SectionTitle>
            <div className="relative">
              <div className="absolute top-6 bottom-6 left-[2.15rem] w-px bg-border" aria-hidden />
              {trace.steps.map((step, index) => (
                <StepRow
                  key={step.step_id}
                  step={step}
                  index={index}
                  culprit={culpritIds.has(step.step_id)}
                  culpritRef={step.step_id === firstCulprit ? culpritRef : undefined}
                />
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-4">
          {trace.diagnosis ? (
            <section className="space-y-3 rounded-2xl bg-card p-5 shadow-island">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Diagnosis</h2>
                <span className="text-xs text-muted-foreground">{Math.round(trace.diagnosis.confidence * 100)}% confidence</span>
              </div>
              <p className="text-sm font-medium">{categoryLabel(trace.diagnosis.category)}</p>
              <p className="text-sm leading-relaxed">{trace.diagnosis.cause}</p>
              {trace.diagnosis.evidence.length > 0 && (
                <div>
                  <p className="mb-1.5 text-sm text-muted-foreground">Evidence</p>
                  <ul className="space-y-1">
                    {trace.diagnosis.evidence.map((item) => (
                      <li key={item} className="text-sm leading-relaxed">{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {trace.diagnosis.proposed_fixes.length > 0 && (
                <div>
                  <p className="mb-1.5 text-sm text-muted-foreground">Proposed fixes</p>
                  <div className="flex flex-wrap gap-1.5">
                    {trace.diagnosis.proposed_fixes.map((fix) => (
                      <FixChip key={fix} fix={fix} />
                    ))}
                  </div>
                </div>
              )}
            </section>
          ) : (
            <StateCard
              icon={Sparkles}
              title="No diagnosis yet"
              description="Grok can suggest a cause and a fix from this trace."
              action={
                <div className="flex flex-col items-center gap-3">
                  <Button size="sm" className="rounded-full" onClick={() => void handleDiagnose()} disabled={diagnosing}>
                    {diagnosing ? "Diagnosing…" : "Diagnose with Grok"}
                  </Button>
                  {diagnoseError != null && <p className="text-sm text-destructive">{friendlyApiMessage(diagnoseError)}</p>}
                  {diagnoseError != null && <DiagnosisDetails error={diagnoseError} />}
                </div>
              }
            />
          )}

          <section className="space-y-3 rounded-2xl bg-card p-5 shadow-island">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Verifier</h2>
              <span className={cn("text-sm font-medium", trace.outcome.verifier.passed ? "text-passed" : "text-failed")}>
                {trace.outcome.verifier.passed ? "Passed" : "Failed"}
              </span>
            </div>
            <div className="space-y-2">
              {trace.outcome.verifier.checks.map((check) => (
                <div key={check.name} className="space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <CodeTip label={checkLabel(check.name)} code={check.name}>
                      <span className="text-sm">{checkLabel(check.name)}</span>
                    </CodeTip>
                    <span className={cn("text-sm", check.passed ? "text-passed" : "text-failed")}>{check.passed ? "Passed" : "Failed"}</span>
                  </div>
                  {!check.passed && <p className="text-sm text-muted-foreground">{check.detail}</p>}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </Page>
  );
}

function DiagnosisDetails({ error }: { error: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setOpen((value) => !value)}>
        {open ? "Hide details" : "Show details"}
      </button>
      {open && apiErrorDetails(error) && <p className="mt-1 font-mono text-xs text-muted-foreground">{apiErrorDetails(error)}</p>}
    </div>
  );
}

function FixChip({ fix }: { fix: FixKind }) {
  return (
    <span className="inline-flex items-center rounded-md border border-current/15 bg-info-soft px-2 py-0.5 text-xs font-medium text-info">
      <CodeTip label={FIX_LABEL[fix]} code={fix} />
    </span>
  );
}

function StepRow({
  step,
  index,
  culprit,
  culpritRef,
}: {
  step: TraceStep;
  index: number;
  culprit: boolean;
  culpritRef?: RefObject<HTMLDivElement | null>;
}) {
  const Icon = STEP_ICON[step.type];
  const [expanded, setExpanded] = useState(culprit);
  const long = (step.content?.length ?? 0) > 280;
  return (
    <div
      id={`step-${step.step_id}`}
      ref={culpritRef}
      className={cn("relative flex gap-3 border-b border-border/30 px-5 py-4 last:border-0", culprit && "bg-warning-soft/40")}
    >
      <div className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-card text-foreground ring-1 ring-border">
        <Icon className="size-3.5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">{index + 1}</span>
          <CodeTip label={STEP_TYPE_LABEL[step.type]} code={step.type}>
            <span className="text-sm font-medium">{STEP_TYPE_LABEL[step.type]}</span>
          </CodeTip>
          <CodeTip label={STEP_ROLE_LABEL[step.role]} code={step.role}>
            <span className="text-xs text-muted-foreground">{STEP_ROLE_LABEL[step.role]}</span>
          </CodeTip>
          {step.tool_name && <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">{step.tool_name}</span>}
          {culprit && (
            <span className="rounded-md border border-current/15 bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
              culprit step
            </span>
          )}
          <span className="ml-auto text-xs text-muted-foreground">{formatClock(step.timestamp)}</span>
        </div>
        {step.content && (
          <div className="mt-1.5">
            <p className={cn("text-sm leading-relaxed", !expanded && long && "line-clamp-3")}>{step.content}</p>
            {long && (
              <button type="button" className="mt-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}
        {step.tool_input !== undefined && step.type === "tool_call" && (
          <JsonBlock label="Input" value={step.tool_input} defaultOpen={culprit} />
        )}
        {step.tool_output !== undefined && step.type === "tool_result" && (
          <JsonBlock label="Output" value={step.tool_output} defaultOpen={culprit} />
        )}
      </div>
      <div className="shrink-0 pt-0.5 text-right">
        <p className="text-xs text-muted-foreground">{formatDuration(step.latency_ms)}</p>
        <p className="text-xs text-muted-foreground">{formatCost(step.cost_usd)}</p>
      </div>
    </div>
  );
}

function JsonBlock({ label, value, defaultOpen }: { label: string; value: unknown; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-2">
      <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {label}
      </button>
      {open && (
        <pre className="mt-1.5 overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-sm font-medium">{value}</p>
    </div>
  );
}

function TraceSkeleton() {
  return (
    <Page>
      <Skeleton className="mt-4 h-6 w-48" />
      <Skeleton className="h-24" />
      <Skeleton className="h-64" />
    </Page>
  );
}
