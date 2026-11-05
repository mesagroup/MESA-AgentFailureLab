import { cn } from "@/lib/utils";
import { TRACE_SOURCE_LABELS, type TraceSource } from "@/lib/traces";

const STYLES: Record<TraceSource, string> = {
  harness: "bg-zinc-500/10 text-muted-foreground border-border",
  demo_seed: "bg-blue-500/15 text-blue-500 border-blue-500/20",
  otel_prod: "bg-emerald-500/15 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  otel_test: "bg-amber-500/15 text-amber-600 border-amber-500/20 dark:text-amber-400",
  production: "bg-violet-500/15 text-violet-600 border-violet-500/20 dark:text-violet-400",
};

export function TraceSourceBadge({ source }: { source: TraceSource }) {
  return (
    <span
      title={TRACE_SOURCE_LABELS[source]}
      className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono", STYLES[source])}
    >
      {source}
    </span>
  );
}
