import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getJuryCase, listAgents, postJuryCase } from "@/lib/api";
import {
  JURY_PERMISSIONS,
  JURY_SESSION_KEY,
  baselineSourceLabel,
  formDefaults,
  formHints,
  injectedParentRunId,
  isWorldBusy,
  juryLaunchBody,
  juryReplayBody,
  noteMaxChars,
  openableBaselineHref,
  parseJurySession,
  permissionChoices,
  replayFixKinds,
  runHref,
  sameVerdictLabel,
  tasksForJury,
  traceHref,
  traceUiRoute,
  validateJuryForm,
  type JuryBaselineComparison,
  type JuryCaseDescription,
  type JuryCaseReport,
  type JuryFormValues,
  type JurySession,
  type JuryTaskChoice,
} from "@/lib/jury";
import { cn } from "@/lib/utils";

type BusyAction = "launch" | "replay";

interface RequestFailure {
  kind: "world_busy" | "error";
  action: BusyAction;
  detail: string;
}

function loadSession(): JurySession | null {
  try {
    return parseJurySession(sessionStorage.getItem(JURY_SESSION_KEY));
  } catch {
    return null;
  }
}

function failureFrom(error: unknown, action: BusyAction, busyCode?: string | null): RequestFailure {
  if (isWorldBusy(error, busyCode)) {
    const detail = error instanceof Error ? error.message : "";
    return { kind: "world_busy", action, detail };
  }
  const detail = error instanceof Error ? error.message : "Richiesta non riuscita.";
  return { kind: "error", action, detail };
}

export function JuryPage() {
  const [restored] = useState<JurySession | null>(() => loadSession());
  const [description, setDescription] = useState<JuryCaseDescription | null>(null);
  const [tasks, setTasks] = useState<JuryTaskChoice[]>([]);
  const [form, setForm] = useState<JuryFormValues | null>(restored?.form ?? null);
  const [submitted, setSubmitted] = useState<JuryFormValues | null>(restored?.submitted ?? null);
  const [launch, setLaunch] = useState<JuryCaseReport | null>(restored?.launch ?? null);
  const [replay, setReplay] = useState<JuryCaseReport | null>(restored?.replay ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingCase, setLoadingCase] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [pending, setPending] = useState<BusyAction | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<RequestFailure | null>(null);

  useEffect(() => {
    if (!form) return;
    try {
      const session: JurySession = { form, submitted, launch, replay };
      sessionStorage.setItem(JURY_SESSION_KEY, JSON.stringify(session));
    } catch {
      // The draft stays on screen if the browser refuses the write.
    }
  }, [form, submitted, launch, replay]);

  useEffect(() => {
    let cancelled = false;
    setLoadingCase(true);
    setLoadError(null);
    Promise.all([getJuryCase(), listAgents().catch(() => [])])
      .then(([nextDescription, agents]) => {
        if (cancelled) return;
        setDescription(nextDescription);
        const taskId = formDefaults(nextDescription).taskId;
        setTasks(tasksForJury(agents, taskId));
        setForm((current) => current ?? formDefaults(nextDescription));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Descrizione del caso non disponibile.");
      })
      .finally(() => {
        if (!cancelled) setLoadingCase(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadId]);

  const choices = description ? permissionChoices(description) : [...JURY_PERMISSIONS];
  const hints = formHints(description);
  const maxChars = noteMaxChars(description);
  const uiRoute = traceUiRoute(description);
  const fixKinds = replayFixKinds(description);
  const parentRunId = injectedParentRunId(launch);
  const busyCode = description?.frontend?.http_409?.jury_and_runs;

  async function launchCase() {
    if (!form) return;
    const issue = validateJuryForm(form, maxChars);
    if (issue) {
      setFormError(issue);
      return;
    }
    setFormError(null);
    setRequestError(null);
    setPending("launch");
    try {
      const report = await postJuryCase(juryLaunchBody(form, choices));
      setSubmitted({ ...form, note: form.note.trim(), taskId: form.taskId.trim() });
      setLaunch(report);
      setReplay(null);
    } catch (error) {
      setRequestError(failureFrom(error, "launch", busyCode));
    } finally {
      setPending(null);
    }
  }

  async function replayGuard() {
    if (!submitted || !parentRunId) return;
    setFormError(null);
    setRequestError(null);
    setPending("replay");
    try {
      const report = await postJuryCase(juryReplayBody(submitted, parentRunId, choices, fixKinds));
      setReplay(report);
    } catch (error) {
      setRequestError(failureFrom(error, "replay", busyCode));
    } finally {
      setPending(null);
    }
  }

  function retry() {
    if (requestError?.action === "replay") void replayGuard();
    else void launchCase();
  }

  return (
    <div className="px-5 pb-10 max-w-5xl mx-auto space-y-4">
      <div className="pt-2 pb-1">
        <h1 className="text-xl font-semibold">Giuria</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Nota malevola · il verdetto è outcome.verifier
        </p>
      </div>

      <ol className="rounded-2xl bg-card shadow-island px-5 py-4 list-decimal pl-9 text-sm text-muted-foreground space-y-1">
        <li>Scrivi la nota, scegli il task e i permessi di sessione.</li>
        <li>Avvia il caso. L&apos;attacker inietta fault.attacker sul run.</li>
        <li>Leggi il verifier e il confronto con la baseline.</li>
        <li>Apri Ispeziona traccia, poi ripeti con permission_guard.</li>
      </ol>

      {loadingCase && !form && (
        <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-9 w-32" />
        </div>
      )}

      {loadError && !form && (
        <div className="rounded-2xl bg-card shadow-island p-5 space-y-3">
          <p className="text-sm font-medium">Il caso giuria non si è caricato.</p>
          <p className="text-xs font-mono text-muted-foreground break-all">{loadError}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => setLoadId((value) => value + 1)}>
            Riprova
          </Button>
        </div>
      )}

      {form && (
        <form
          className="rounded-2xl bg-card shadow-island p-5 space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void launchCase();
          }}
        >
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="jury-note" className="text-sm font-medium">Nota del giurato</label>
              <span className={cn(
                "text-xs font-mono text-muted-foreground",
                form.note.trim().length > maxChars && "text-red-500",
              )}>
                {form.note.trim().length}/{maxChars}
              </span>
            </div>
            <textarea
              id="jury-note"
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
              rows={7}
              className="w-full rounded-none border-0 border-b border-border/60 bg-transparent px-0 py-1 text-sm placeholder:text-muted-foreground/50 focus-visible:border-foreground focus-visible:outline-none resize-y"
            />
            <p className="text-xs text-muted-foreground">{hints.note}</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="jury-task" className="text-sm font-medium">Task</label>
            <select
              id="jury-task"
              value={form.taskId}
              onChange={(event) => setForm({ ...form, taskId: event.target.value })}
              className="h-9 w-full max-w-md rounded-md border border-border bg-transparent px-2 text-sm font-mono"
            >
              {(tasks.length > 0 ? tasks : [{ id: form.taskId, title: form.taskId }]).map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title && task.title !== task.id ? `${task.id} — ${task.title}` : task.id}
                </option>
              ))}
              {tasks.length > 0 && !tasks.some((task) => task.id === form.taskId) && (
                <option value={form.taskId}>{form.taskId}</option>
              )}
            </select>
            <p className="text-xs text-muted-foreground">{hints.task}</p>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Permessi</legend>
            <div className="flex flex-wrap gap-2">
              {choices.map((permission) => {
                const active = form.permissions.includes(permission);
                return (
                  <button
                    key={permission}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      const next = new Set(form.permissions);
                      if (next.has(permission)) next.delete(permission);
                      else next.add(permission);
                      setForm({ ...form, permissions: choices.filter((name) => next.has(name)) });
                    }}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-xs font-mono border transition-colors",
                      active
                        ? "border-foreground bg-foreground text-background"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {permission}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">{hints.permissions}</p>
          </fieldset>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.includeBaseline}
              onChange={(event) => setForm({ ...form, includeBaseline: event.target.checked })}
            />
            <span>
              Includi baseline
              <span className="block text-xs text-muted-foreground">{hints.includeBaseline}</span>
            </span>
          </label>

          {loadError && (
            <p className="text-xs text-muted-foreground">
              Descrizione non aggiornata: {loadError}
            </p>
          )}
          {formError && <p className="text-sm text-red-500">{formError}</p>}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending !== null}>
              {pending === "launch" ? "Avvio in corso…" : "Avvia caso"}
            </Button>
            <span className="text-xs text-muted-foreground">POST /attacker/jury-case</span>
          </div>
        </form>
      )}

      {requestError && (
        <RequestNotice failure={requestError} pending={pending !== null} onRetry={retry} />
      )}

      {launch && (
        <ResultPanel
          title="Attacco"
          report={launch}
          uiRoute={uiRoute}
          replay={parentRunId ? {
            parentRunId,
            fixKinds: fixKinds.join(", "),
            pending: pending === "replay",
            disabled: pending !== null,
            onReplay: () => void replayGuard(),
          } : null}
        />
      )}

      {replay && <ResultPanel title="Replay · permission_guard" report={replay} uiRoute={uiRoute} replay={null} />}
    </div>
  );
}

function RequestNotice({
  failure,
  pending,
  onRetry,
}: {
  failure: RequestFailure;
  pending: boolean;
  onRetry: () => void;
}) {
  if (failure.kind === "world_busy") {
    return (
      <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 space-y-2">
        <p className="text-sm font-medium">Il mondo mock è occupato da un altro run.</p>
        <p className="text-xs text-muted-foreground">
          Riprova quando quel run finisce. Non è un fallimento del verifier.
        </p>
        {failure.detail && <p className="text-xs font-mono text-muted-foreground break-all">{failure.detail}</p>}
        <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={pending}>
          Riprova
        </Button>
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 space-y-1">
      <p className="text-sm font-medium">La richiesta non è andata a buon fine.</p>
      <p className="text-xs font-mono text-muted-foreground break-all">{failure.detail}</p>
    </div>
  );
}

function ResultPanel({
  title,
  report,
  uiRoute,
  replay,
}: {
  title: string;
  report: JuryCaseReport;
  uiRoute: string;
  replay: { parentRunId: string; fixKinds: string; pending: boolean; disabled: boolean; onReplay: () => void } | null;
}) {
  const traceTo = traceHref(report.links.attacked_trace, uiRoute);
  const runTo = runHref(report.links.attacked_run);
  const attacker = report.attacked.trace.fault.attacker;
  const passed = report.outcome.verifier.passed;

  return (
    <section className="rounded-2xl bg-card shadow-island p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-xs font-mono text-muted-foreground mt-1">
            {report.attacked.run.phase} · {report.attacked.run.run_id}
          </p>
        </div>
        <span className={cn(
          "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono",
          attacker.used
            ? "bg-amber-500/15 text-amber-500 border-amber-500/20"
            : "bg-muted text-muted-foreground border-border",
        )}>
          fault.attacker {attacker.used ? "used" : "off"}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
        <Fact label="payload_id" value={attacker.payload_id ?? "—"} mono />
        <Fact label="client chiamato" value={report.client_called === undefined ? "—" : report.client_called ? "sì" : "no"} />
        <Fact
          label="X-Permissions"
          value={(report.wire_permissions ?? report.granted_permissions ?? []).join(", ") || "—"}
          mono
        />
      </dl>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-medium">Esito verifier</h3>
          <span className={cn("text-xs font-mono", passed ? "text-green-500" : "text-red-400")}>
            {passed ? "passed" : "failed"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          outcome.verifier è l&apos;unico pass/fail di questo lancio. diagnosis resta null.
        </p>
        <ul className="space-y-2">
          {report.outcome.verifier.checks.map((check, index) => (
            <li key={`${check.name}-${index}`} className="space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-mono">{check.name}</span>
                <span className={cn("text-xs font-mono", check.passed ? "text-green-500" : "text-red-400")}>
                  {check.passed ? "passed" : "failed"}
                </span>
              </div>
              {check.detail && <p className="text-xs text-muted-foreground leading-relaxed">{check.detail}</p>}
            </li>
          ))}
        </ul>
      </div>

      <BaselineComparison comparison={report.baseline_comparison} links={report.links} uiRoute={uiRoute} />

      <div className="flex flex-wrap items-center gap-3">
        {traceTo ? (
          <Link to={traceTo} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Ispeziona traccia
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">Nessun link alla traccia attaccata.</span>
        )}
        {runTo && (
          <Link to={runTo} className="text-xs text-muted-foreground hover:text-foreground">
            Apri run
          </Link>
        )}
        {replay && (
          <Button type="button" size="sm" onClick={replay.onReplay} disabled={replay.disabled}>
            {replay.pending ? "Replay in corso…" : "Replay permission_guard"}
          </Button>
        )}
      </div>
      {replay && (
        <p className="text-xs text-muted-foreground">
          Stessa nota e gli stessi permessi del controllo. fix_kinds {replay.fixKinds}, parent_run_id {replay.parentRunId}.
        </p>
      )}
    </section>
  );
}

function BaselineComparison({
  comparison,
  links,
  uiRoute,
}: {
  comparison: JuryBaselineComparison;
  links: JuryCaseReport["links"];
  uiRoute: string;
}) {
  const baselineTo = openableBaselineHref(comparison.source, links.baseline_trace, uiRoute);
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium">Confronto baseline</h3>
      <p className="text-xs text-muted-foreground">{baselineSourceLabel(comparison.source)}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground text-left">
              <th className="py-1.5 pr-3 font-medium" />
              <th className="py-1.5 pr-3 font-medium">Baseline</th>
              <th className="py-1.5 font-medium">Attacco</th>
            </tr>
          </thead>
          <tbody className="font-mono text-xs">
            <CompareRow
              label="verifier"
              baseline={passedWord(comparison.baseline_verifier_passed)}
              attacked={comparison.attacked_verifier_passed ? "passed" : "failed"}
            />
            <CompareRow
              label="ordine"
              baseline={comparison.baseline_order_status ?? "—"}
              attacked={comparison.attacked_order_status ?? "—"}
            />
            <tr className="border-t border-border/40">
              <th className="py-1.5 pr-3 text-left font-sans font-normal text-muted-foreground">traccia</th>
              <td className="py-1.5 pr-3">
                {baselineTo ? (
                  <Link to={baselineTo} className="hover:text-foreground underline-offset-2 hover:underline">
                    {comparison.baseline_trace_id ?? "apri"}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">
                    {comparison.source === "frozen"
                      ? `fixture, non in memoria${comparison.fixture?.trace ? ` · ${comparison.fixture.trace}` : ""}`
                      : "—"}
                  </span>
                )}
              </td>
              <td className="py-1.5">{comparison.attacked_trace_id}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Stesso verdetto: {sameVerdictLabel(comparison.same_verdict)}
      </p>
    </div>
  );
}

function CompareRow({ label, baseline, attacked }: { label: string; baseline: string; attacked: string }) {
  return (
    <tr className="border-t border-border/40">
      <th className="py-1.5 pr-3 text-left font-sans font-normal text-muted-foreground">{label}</th>
      <td className="py-1.5 pr-3">{baseline}</td>
      <td className="py-1.5">{attacked}</td>
    </tr>
  );
}

function passedWord(value: boolean | null): string {
  if (value === null) return "—";
  return value ? "passed" : "failed";
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 break-all", mono && "font-mono text-xs")}>{value}</dd>
    </div>
  );
}
