import type { RunPhase, RunStatus, TraceStatus } from "@mesa/shared";
import { cn } from "@/lib/utils";
import { PHASE_LABEL, STATUS_LABEL, checksSummary } from "@/lib/labels";

const TONE = {
  neutral: "bg-muted text-foreground",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  passed: "bg-passed-soft text-passed",
  failed: "bg-failed-soft text-failed",
  error: "bg-error-soft text-error",
} as const;

function Badge({ tone, children, className }: { tone: keyof typeof TONE; children: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-md border border-current/15 px-2 py-0.5 text-xs font-medium", TONE[tone], className)}>
      {children}
    </span>
  );
}

export function PhaseBadge({ phase }: { phase: RunPhase }) {
  const tone = phase === "baseline" ? "info" : phase === "injected" ? "warning" : "passed";
  return <Badge tone={tone}>{PHASE_LABEL[phase]}</Badge>;
}

const STATUS_TONE: Record<RunStatus | TraceStatus, keyof typeof TONE> = {
  queued: "neutral",
  running: "info",
  passed: "passed",
  completed: "passed",
  failed: "failed",
  error: "error",
  timeout: "warning",
};

export function StatusBadge({ status }: { status: RunStatus | TraceStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function VerifierBadge({
  passed,
  checks,
}: {
  passed: boolean;
  checks?: readonly { passed: boolean; name?: string }[];
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={passed ? "passed" : "failed"}>{passed ? "Passed" : "Failed"}</Badge>
      {checks && checks.length > 0 && (
        <span className="text-xs text-muted-foreground">{checksSummary(checks)}</span>
      )}
    </span>
  );
}
