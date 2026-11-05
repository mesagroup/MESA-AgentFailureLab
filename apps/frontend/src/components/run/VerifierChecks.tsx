import { cn } from "@/lib/utils";
import type { RunVerifierView } from "@/lib/run-detail";

export function VerifierChecks({
  verifier,
  empty,
}: {
  verifier: RunVerifierView | null;
  empty: string | null;
}) {
  return (
    <section className="rounded-2xl bg-card shadow-island p-5 space-y-4" data-testid="run-verifier">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Evaluation</p>
          <h2 className="text-sm font-semibold mt-0.5">Verifier</h2>
        </div>
        {verifier ? (
          <span
            className={cn(
              "text-xs font-mono rounded-md border px-2 py-0.5",
              verifier.passed
                ? "bg-green-500/15 text-green-600 border-green-500/20"
                : "bg-red-500/15 text-red-500 border-red-500/20",
            )}
          >
            {verifier.passed ? "passed" : "failed"}
          </span>
        ) : (
          <span className="text-xs font-mono text-muted-foreground">—</span>
        )}
      </div>

      {empty && <p className="text-sm text-muted-foreground">{empty}</p>}

      {verifier && verifier.checks.length > 0 && (
        <ul className="space-y-3">
          {verifier.checks.map((check) => (
            <li key={check.name} className="rounded-xl border border-border/40 px-3 py-2.5 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-mono">{check.name}</span>
                <span
                  className={cn(
                    "text-xs font-mono shrink-0",
                    check.passed ? "text-green-600" : "text-red-500",
                  )}
                >
                  {check.passed ? "pass" : "fail"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{check.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
