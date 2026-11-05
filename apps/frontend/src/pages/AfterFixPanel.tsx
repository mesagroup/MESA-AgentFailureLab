import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  FIX_KIND_LABELS,
  compareBeforeAfter,
  formatCostUsd,
  formatDurationMs,
  parentChildLinks,
  passedWord,
  runHref,
  traceHref,
  type BeforeAfterView,
  type RunResultLinks,
} from "@/lib/after-fix";
import { runPhaseLabel } from "@/lib/run-launch";
import { cn } from "@/lib/utils";
import type { FixKind, Run, TraceOutcome, TraceTotals } from "@mesa/shared";

export interface VerifierTraceView {
  trace_id: string;
  outcome: { verifier: TraceOutcome["verifier"] };
  totals: TraceTotals;
}

export function AfterFixPanel({
  proposed,
  selected,
  suggested,
  onToggle,
  onReplay,
  pending,
  error,
  worldBusy,
  cleanTreated,
  onCleanTreated,
  parentRun,
  parentTrace,
  childRun,
  childTrace,
  childRuns,
  resultLinks,
}: {
  proposed: FixKind[];
  selected: FixKind[];
  suggested?: FixKind;
  onToggle: (kind: FixKind) => void;
  onReplay: () => void;
  pending: boolean;
  error: string | null;
  worldBusy: boolean;
  cleanTreated: boolean;
  onCleanTreated: (value: boolean) => void;
  parentRun: Run | null;
  parentTrace: VerifierTraceView | null;
  childRun: Run | null;
  childTrace: VerifierTraceView | null;
  childRuns: Run[];
  resultLinks: RunResultLinks | null;
}) {
  const links = parentChildLinks({
    parentRun,
    childRun,
    parentTrace,
    childTrace,
    links: resultLinks,
  });
  const comparison = childTrace || childRun
    ? compareBeforeAfter({
        before: {
          verifier: parentTrace?.outcome.verifier,
          totals: parentTrace?.totals,
          duration_ms: parentRun?.duration_ms,
        },
        after: {
          verifier: childTrace?.outcome.verifier,
          totals: childTrace?.totals,
          duration_ms: childRun?.duration_ms,
        },
      })
    : null;
  const hasLineage = Boolean(parentRun?.run_id || childRun?.run_id || childRuns.length);
  if (proposed.length === 0 && !comparison && !hasLineage && !error && !worldBusy) return null;

  return (
    <div className="space-y-4">
      {proposed.length > 0 && (
        <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium">Select fixes</span>
            <span className="text-xs font-mono text-muted-foreground">diagnosis.proposed_fixes</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Same FixKind ids as Run.fix_kinds: controlled_retry, pre_response_check, permission_guard.
            There is no fault_kinds field. POST /runs with phase after_fix, parent_run_id, and fix_kinds.
            Omit injection to replay the parent fault.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {proposed.map((kind) => {
              const active = selected.includes(kind);
              const adr = suggested === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onToggle(kind)}
                  className={cn(
                    "px-2.5 py-1 rounded-full text-xs font-mono border transition-colors",
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {FIX_KIND_LABELS[kind]}
                  {adr ? " · ADR-002" : ""}
                </button>
              );
            })}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={cleanTreated}
              onChange={(event) => onCleanTreated(event.target.checked)}
            />
            <span>
              Clean treated
              <span className="block text-xs text-muted-foreground">
                Sends injection: null. Leave unchecked to omit injection and replay the parent fault.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" onClick={onReplay} disabled={pending || selected.length === 0}>
              {pending ? "Replaying…" : "Replay after_fix"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {selected.length === 0 ? "Select at least one fix." : `fix_kinds ${selected.join(", ")}`}
            </span>
          </div>
        </div>
      )}

      {worldBusy && (
        <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 space-y-2">
          <p className="text-sm font-medium">The mock world is busy with another run.</p>
          <p className="text-xs text-muted-foreground">
            Retry when that run finishes. This is not a verifier failure.
          </p>
          {error && <p className="text-xs font-mono text-muted-foreground break-all">{error}</p>}
          <Button type="button" size="sm" variant="outline" onClick={onReplay} disabled={pending}>
            Retry
          </Button>
        </div>
      )}

      {error && !worldBusy && (
        <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 space-y-1">
          <p className="text-sm font-medium">The replay did not start.</p>
          <p className="text-xs font-mono text-muted-foreground break-all">{error}</p>
        </div>
      )}

      <LineageCard
        links={links}
        parentRun={parentRun}
        childRun={childRun}
        childRuns={childRuns}
      />

      {comparison && (
        <BeforeAfterCard
          view={comparison}
          parentTraceId={links.parent_trace_id}
          childTraceId={links.child_trace_id}
        />
      )}
    </div>
  );
}

function LineageCard({
  links,
  parentRun,
  childRun,
  childRuns,
}: {
  links: ReturnType<typeof parentChildLinks>;
  parentRun: Run | null;
  childRun: Run | null;
  childRuns: Run[];
}) {
  const parentTo = runHref(links.parent_run_id);
  const childTo = runHref(links.child_run_id);
  const parentTraceTo = traceHref(links.parent_trace_id);
  const childTraceTo = traceHref(links.child_trace_id);
  const extras = childRuns.filter((run) => run.run_id !== links.child_run_id);
  if (!parentTo && !childTo && extras.length === 0) return null;

  return (
    <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
      <span className="text-xs font-medium">Parent / child runs</span>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
        <Fact
          label="parent_run_id"
          value={links.parent_run_id ?? "—"}
          href={parentTo}
          extraHref={parentTraceTo}
          extraLabel="parent trace"
        />
        <Fact
          label="after_fix run"
          value={links.child_run_id ?? "—"}
          href={childTo}
          extraHref={childTraceTo}
          extraLabel="after_fix trace"
        />
      </dl>
      {childRun?.fix_kinds?.length ? (
        <p className="text-xs text-muted-foreground">
          {runPhaseLabel(childRun.phase)} · fix_kinds {childRun.fix_kinds.join(", ")}
        </p>
      ) : parentRun?.phase ? (
        <p className="text-xs text-muted-foreground">{runPhaseLabel(parentRun.phase)}</p>
      ) : null}
      {extras.length > 0 && (
        <ul className="space-y-1">
          {extras.map((run) => {
            const href = runHref(run.run_id);
            const tHref = traceHref(run.trace_ids[0]);
            return (
              <li key={run.run_id} className="text-xs font-mono text-muted-foreground">
                {href ? (
                  <Link to={href} className="hover:text-foreground underline-offset-2 hover:underline">
                    {run.run_id}
                  </Link>
                ) : (
                  run.run_id
                )}
                {tHref && (
                  <>
                    {" · "}
                    <Link to={tHref} className="hover:text-foreground underline-offset-2 hover:underline">
                      trace
                    </Link>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function BeforeAfterCard({
  view,
  parentTraceId,
  childTraceId,
}: {
  view: BeforeAfterView;
  parentTraceId: string | null;
  childTraceId: string | null;
}) {
  const beforeTo = traceHref(parentTraceId);
  const afterTo = traceHref(childTraceId);
  return (
    <div className="rounded-2xl bg-card shadow-island p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">Before / after</span>
        <span className="text-xs font-mono text-muted-foreground">outcome.verifier</span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Success is verifier.passed. A regression is a check that passed before and failed after.
        Timing is Trace.totals.latency_ms and Run.duration_ms. Cost is Trace.totals.cost_usd.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground text-left">
              <th className="py-1.5 pr-3 font-medium" />
              <th className="py-1.5 pr-3 font-medium">Before</th>
              <th className="py-1.5 font-medium">After</th>
            </tr>
          </thead>
          <tbody className="font-mono text-xs">
            <CompareRow
              label="verifier"
              before={passedWord(view.beforePassed)}
              after={passedWord(view.afterPassed)}
              beforeTone={view.beforePassed}
              afterTone={view.afterPassed}
            />
            {view.checks.map((check) => (
              <CompareRow
                key={check.name}
                label={check.name}
                before={passedWord(check.beforePassed)}
                after={passedWord(check.afterPassed)}
                beforeTone={check.beforePassed}
                afterTone={check.afterPassed}
                note={check.regression ? "regression" : check.recovered ? "recovered" : undefined}
              />
            ))}
            <CompareRow
              label="latency"
              before={formatDurationMs(view.timing.latency_ms.before)}
              after={formatDurationMs(view.timing.latency_ms.after)}
            />
            <CompareRow
              label="duration"
              before={formatDurationMs(view.timing.duration_ms.before)}
              after={formatDurationMs(view.timing.duration_ms.after)}
            />
            <CompareRow
              label="cost"
              before={formatCostUsd(view.timing.cost_usd.before)}
              after={formatCostUsd(view.timing.cost_usd.after)}
            />
            <tr className="border-t border-border/40">
              <th className="py-1.5 pr-3 text-left font-sans font-normal text-muted-foreground">trace</th>
              <td className="py-1.5 pr-3">
                {beforeTo ? (
                  <Link to={beforeTo} className="hover:text-foreground underline-offset-2 hover:underline">
                    {parentTraceId}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="py-1.5">
                {afterTo ? (
                  <Link to={afterTo} className="hover:text-foreground underline-offset-2 hover:underline">
                    {childTraceId}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Regressions: {view.regressions.length === 0 ? "none" : view.regressions.join(", ")}
      </p>
    </div>
  );
}

function CompareRow({
  label,
  before,
  after,
  beforeTone,
  afterTone,
  note,
}: {
  label: string;
  before: string;
  after: string;
  beforeTone?: boolean | null;
  afterTone?: boolean | null;
  note?: string;
}) {
  return (
    <tr className="border-t border-border/40">
      <th className="py-1.5 pr-3 text-left font-sans font-normal text-muted-foreground">
        {label}
        {note && <span className="ml-2 font-mono text-[10px] text-amber-500">{note}</span>}
      </th>
      <td className={cn("py-1.5 pr-3", toneClass(beforeTone))}>{before}</td>
      <td className={cn("py-1.5", toneClass(afterTone))}>{after}</td>
    </tr>
  );
}

function toneClass(value: boolean | null | undefined): string {
  if (value === true) return "text-green-500";
  if (value === false) return "text-red-400";
  return "";
}

function Fact({
  label,
  value,
  href,
  extraHref,
  extraLabel,
}: {
  label: string;
  value: string;
  href: string | null;
  extraHref: string | null;
  extraLabel: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-xs break-all">
        {href ? (
          <Link to={href} className="hover:text-foreground underline-offset-2 hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
        {extraHref && (
          <>
            {" · "}
            <Link to={extraHref} className="hover:text-foreground underline-offset-2 hover:underline">
              {extraLabel}
            </Link>
          </>
        )}
      </dd>
    </div>
  );
}
