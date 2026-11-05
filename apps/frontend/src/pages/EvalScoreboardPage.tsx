import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, getEvalResults, type EvalMetric, type EvalResults } from "@/lib/api";
import { cn } from "@/lib/utils";

function formatTs(iso: string): string {
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

function pct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

function StatsCell({ hits, total, rate }: { hits: number; total: number; rate: number }) {
  return (
    <span className="font-mono text-sm">
      {hits}/{total}{" "}
      <span className="text-muted-foreground text-xs">({pct(rate)})</span>
    </span>
  );
}

function DeltaCell({ baseline, grok }: { baseline: number; grok: number | null }) {
  if (grok === null) return <span className="text-muted-foreground text-sm">—</span>;
  const diff = grok - baseline;
  const diffPct = Math.round(diff * 100);
  if (diffPct === 0) return <span className="text-muted-foreground text-sm">—</span>;
  return (
    <span
      className={cn(
        "font-mono text-sm font-medium",
        diffPct > 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
      )}
    >
      {diffPct > 0 ? "+" : ""}
      {diffPct}%
    </span>
  );
}

function MetricRow({ metric }: { metric: EvalMetric }) {
  return (
    <tr className="border-b border-border/30 last:border-0">
      <td className="px-4 py-3 text-sm font-medium">{metric.label || metric.id}</td>
      <td className="px-4 py-3">
        <StatsCell {...metric.baseline} />
      </td>
      <td className="px-4 py-3">
        {metric.grok ? <StatsCell {...metric.grok} /> : <span className="text-muted-foreground text-sm">—</span>}
      </td>
      <td className="px-4 py-3">
        <DeltaCell baseline={metric.baseline.rate} grok={metric.grok?.rate ?? null} />
      </td>
    </tr>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b border-border/30 last:border-0">
      {[...Array(4)].map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-5 w-24" />
        </td>
      ))}
    </tr>
  );
}

function errorMessage(err: unknown): { type: "configured" | "not_found" | "generic"; text: string } {
  if (err instanceof ApiError) {
    if (err.status === 503 && err.code === "eval_results_not_configured") {
      return { type: "configured", text: "Agentservice not connected — eval results unavailable" };
    }
    if (err.status === 404 && err.code === "eval_results_not_found") {
      return { type: "not_found", text: "No eval run yet. Run `pnpm eval` to generate results." };
    }
  }
  return { type: "generic", text: err instanceof Error ? err.message : "Failed to load eval results." };
}

export function EvalSection() {
  const [results, setResults] = useState<EvalResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getEvalResults()
      .then((data) => {
        if (cancelled) return;
        setResults(data);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const errInfo = loadError ? errorMessage(loadError) : null;

  return (
    <div className="rounded-2xl bg-card shadow-island overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
        <div>
          <h2 className="text-sm font-semibold">Eval scoreboard</h2>
          {results ? (
            <p className="text-xs text-muted-foreground mt-0.5">
              {formatTs(results.generated_at)} · {results.dataset.scored_count} traces scored
            </p>
          ) : (
            <p className="text-xs text-muted-foreground mt-0.5">Baseline (rules-only) vs. Grok diagnosis quality.</p>
          )}
        </div>
      </div>

      {errInfo && (
        <div
          role="alert"
          className={cn(
            "px-5 py-4",
            errInfo.type === "not_found"
              ? "bg-muted/50"
              : "border-t border-destructive/30 bg-destructive/5",
          )}
        >
          <p
            className={cn(
              "text-sm",
              errInfo.type === "not_found" ? "text-muted-foreground font-mono" : "text-destructive",
            )}
          >
            {errInfo.text}
          </p>
        </div>
      )}

      {!errInfo && (
        <table className="w-full">
          <thead>
            <tr className="border-b border-border/40 bg-muted/30">
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Metric
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Baseline (rules only)
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Grok
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                &Delta;
              </th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? [...Array(4)].map((_, i) => <SkeletonRow key={i} />)
              : results?.metrics.map((metric) => <MetricRow key={metric.id} metric={metric} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}
