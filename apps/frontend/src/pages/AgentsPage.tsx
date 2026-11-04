import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Bot, PlusCircle, Search } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Agent, AgentInstanceKind, AgentTask, FaultCategory, FixKind, RunPhase } from "@mesa/shared";
import { CodeTip, CopyIdButton } from "@/components/CodeTip";
import { Page, PageHeader } from "@/components/PageHeader";
import { ErrorState, StateCard } from "@/components/StateCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  createRun,
  deleteAgent,
  listAgents,
  listFaults,
  saveAgent,
  updateAgent,
  type AgentDraft,
  type FaultCatalog,
  type RunParams,
} from "@/lib/api";
import { friendlyApiMessage } from "@/lib/errors";
import { FIX_DESCRIPTION, FIX_LABEL, KIND_LABEL, PHASE_DESCRIPTION, PHASE_LABEL, faultCodeLabel, fixKindsInOrder, formatTaskLabel } from "@/lib/labels";
import { blankTasks, taskFieldErrors, tasksHaveErrors, type TaskFieldError } from "@/lib/tasks";
import type { RunInjection } from "@/lib/run-request";
import { cn } from "@/lib/utils";
import { AgentTasksEditor } from "@/pages/AgentTasksEditor";

interface FormState {
  name: string;
  description: string;
  instance_base_url: string;
  test_instance_base_url: string;
  instance_kind: AgentInstanceKind;
  tasks: AgentTask[];
}

interface FormErrors {
  name?: string;
  instance_base_url?: string;
  save?: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  instance_base_url: "",
  test_instance_base_url: "",
  instance_kind: "external",
  tasks: [],
};

const PHASES: RunPhase[] = ["baseline", "injected", "after_fix"];
const TASK_PRESET = "__preset__";
const NO_FAULT = "__none__";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; error: unknown }
  | { phase: "ready"; agents: Agent[] };

function agentToForm(agent: Agent): FormState {
  return {
    name: agent.name,
    description: agent.description,
    instance_base_url: agent.instance.base_url,
    test_instance_base_url: agent.test_instance.base_url,
    instance_kind: agent.instance.kind,
    tasks: structuredClone(agent.tasks),
  };
}

export function AgentsPage() {
  const { agentId } = useParams<{ agentId?: string }>();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [query, setQuery] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [taskErrors, setTaskErrors] = useState<TaskFieldError[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [runAgent, setRunAgent] = useState<Agent | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useDocumentTitle("Agents");

  async function reload() {
    setState({ phase: "loading" });
    try {
      setState({ phase: "ready", agents: await listAgents() });
    } catch (error) {
      setState({ phase: "error", error });
    }
  }

  useEffect(() => { void reload(); }, []);

  useEffect(() => {
    if (!sheetOpen) return;
    const handle = window.setTimeout(() => nameRef.current?.focus(), 40);
    return () => window.clearTimeout(handle);
  }, [sheetOpen]);

  const agents = state.phase === "ready" ? state.agents : [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((agent) => agent.name.toLowerCase().includes(q));
  }, [agents, query]);
  const selected = agents.find((agent) => agent.agent_id === agentId);

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY_FORM, tasks: blankTasks() });
    setErrors({});
    setTaskErrors([]);
    setShowErrors(false);
    setSheetOpen(true);
  }

  function openEdit(agent: Agent) {
    setEditing(agent);
    setForm(agentToForm(agent));
    setErrors({});
    setTaskErrors([]);
    setShowErrors(false);
    setSheetOpen(true);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await deleteAgent(deleteTarget.agent_id);
      setDeleteTarget(null);
      await reload();
    } catch (error) {
      setDeleteError(error);
    }
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    if (key === "name" || key === "instance_base_url") {
      setErrors((current) => ({ ...current, [key]: undefined }));
    }
  }

  async function handleSave() {
    const nextErrors: FormErrors = {};
    if (!form.name.trim()) nextErrors.name = "Name is required.";
    if (!form.instance_base_url.trim()) nextErrors.instance_base_url = "Endpoint is required.";
    const nextTaskErrors = taskFieldErrors(form.tasks);
    setErrors(nextErrors);
    setTaskErrors(nextTaskErrors);
    setShowErrors(true);
    if (Object.keys(nextErrors).length > 0 || tasksHaveErrors(nextTaskErrors)) return;
    const draft: AgentDraft = {
      name: form.name.trim(),
      description: form.description.trim(),
      instance_base_url: form.instance_base_url.trim(),
      test_instance_base_url: form.test_instance_base_url.trim(),
      instance_kind: form.instance_kind,
      tasks: form.tasks,
    };
    try {
      if (editing) await updateAgent(editing.agent_id, draft);
      else await saveAgent(draft);
      await reload();
      setSheetOpen(false);
    } catch (error) {
      setErrors((current) => ({ ...current, save: friendlyApiMessage(error) }));
    }
  }

  return (
    <Page>
      <PageHeader
        title="Agents"
        subtitle="Register an agent, then launch a test."
        actions={
          <Button size="sm" variant="outline" className="gap-1.5 rounded-full" onClick={openCreate}>
            <PlusCircle className="size-3.5" />
            New agent
          </Button>
        }
      />

      <div className="rounded-2xl bg-card shadow-island">
        <div className="flex items-center gap-2.5 px-5 py-3.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name"
            aria-label="Search agents by name"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} className="text-xs text-muted-foreground hover:text-foreground">
              Clear
            </button>
          )}
        </div>
      </div>

      {state.phase === "ready" && (
        <div className="flex justify-end px-1">
          <span className="text-xs text-muted-foreground">
            {query ? `${filtered.length} of ${agents.length}` : `${agents.length} agent${agents.length === 1 ? "" : "s"}`}
          </span>
        </div>
      )}

      {state.phase === "loading" && (
        <div className="rounded-2xl bg-card px-5 py-10 text-center text-sm text-muted-foreground shadow-island">Loading agents…</div>
      )}
      {state.phase === "error" && <ErrorState error={state.error} onRetry={() => void reload()} />}
      {state.phase === "ready" && filtered.length === 0 && (
        <StateCard
          icon={Bot}
          title={query ? "No agents match that name" : "No agents yet"}
          description={query ? undefined : "Register an agent to launch the first test."}
          action={query ? undefined : (
            <Button size="sm" className="rounded-full" onClick={openCreate}>New agent</Button>
          )}
        />
      )}
      {state.phase === "ready" && filtered.length > 0 && (
        <div className="overflow-hidden rounded-2xl bg-card shadow-island">
          {filtered.map((agent) => {
            const isReference = agent.instance.kind === "reference";
            const active = agent.agent_id === agentId;
            return (
              <div
                key={agent.agent_id}
                className={cn(
                  "flex items-center gap-4 border-b border-border/30 px-5 py-3.5 last:border-0",
                  active && "bg-muted/40",
                )}
              >
                <Link to={`/agents/${encodeURIComponent(agent.agent_id)}`} className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{agent.name}</span>
                    <span className="rounded-md border border-current/15 bg-muted px-2 py-0.5 text-xs text-foreground">
                      {KIND_LABEL[agent.instance.kind]}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {agent.tasks.length} task{agent.tasks.length === 1 ? "" : "s"}
                  </span>
                </Link>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="outline" className="rounded-full" aria-label={`Test ${agent.name}`} onClick={() => setRunAgent(agent)}>
                    Test
                  </Button>
                  {!isReference && (
                    <>
                      <Button size="sm" variant="ghost" className="rounded-full" aria-label={`Edit ${agent.name}`} onClick={() => openEdit(agent)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="rounded-full text-destructive hover:text-destructive"
                        aria-label={`Delete ${agent.name}`}
                        onClick={() => { setDeleteError(null); setDeleteTarget(agent); }}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {state.phase === "ready" && agentId && !selected && (
        <StateCard
          icon={Bot}
          title="That agent is not in this session"
          action={<Button size="sm" variant="outline" className="rounded-full" nativeButton={false} render={<Link to="/agents" />}>Back to agents</Button>}
        />
      )}
      {selected && <AgentDetails agent={selected} />}

      <Sheet open={sheetOpen} onOpenChange={(open: boolean) => setSheetOpen(open)}>
        <SheetContent side="bottom" className="flex h-[95vh] flex-col rounded-t-2xl p-0">
          <div className="shrink-0 border-b border-border/40 px-5 pt-6 pb-5 sm:px-8">
            <p className="mb-0.5 text-xs text-muted-foreground">{editing ? "Editing agent" : "New agent"}</p>
            <SheetTitle className="text-base font-medium tracking-tight">{editing ? editing.name : "Register an agent"}</SheetTitle>
          </div>
          <div className="flex flex-1 flex-col overflow-hidden sm:flex-row">
            <div className="w-full shrink-0 space-y-5 overflow-y-auto border-b border-border/40 px-5 py-6 sm:w-[38%] sm:border-r sm:border-b-0 sm:px-8">
              <FormField label="Name" error={showErrors ? errors.name : undefined} required>
                <Input
                  ref={nameRef}
                  value={form.name}
                  onChange={(event) => setField("name", event.target.value)}
                  placeholder="Support agent"
                  aria-invalid={showErrors && Boolean(errors.name)}
                />
              </FormField>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" id="agent-kind-label">Kind</label>
                <Select
                  value={form.instance_kind}
                  disabled={editing?.instance.kind === "reference"}
                  onValueChange={(value) => {
                    if (value === "external" || value === "reference") setField("instance_kind", value);
                  }}
                >
                  <SelectTrigger aria-labelledby="agent-kind-label">
                    <SelectValue>{(value: string | null) => (value === "reference" || value === "external" ? KIND_LABEL[value] : "Kind")}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="external">external</SelectItem>
                    <SelectItem value="reference">reference</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <FormField label="Description">
                <Textarea
                  value={form.description}
                  onChange={(event) => setField("description", event.target.value)}
                  placeholder="What does this agent do?"
                  rows={4}
                />
              </FormField>
            </div>
            <div className="flex-1 space-y-7 overflow-y-auto px-5 py-6 sm:px-8">
              <div className="space-y-3">
                <p className="text-sm font-medium">Endpoint</p>
                <FormField label="Instance URL" error={showErrors ? errors.instance_base_url : undefined} required>
                  <Input
                    value={form.instance_base_url}
                    onChange={(event) => setField("instance_base_url", event.target.value)}
                    placeholder="http://127.0.0.1:3002"
                    className="font-mono text-xs"
                    aria-invalid={showErrors && Boolean(errors.instance_base_url)}
                  />
                </FormField>
                <FormField label="Test URL">
                  <Input
                    value={form.test_instance_base_url}
                    onChange={(event) => setField("test_instance_base_url", event.target.value)}
                    placeholder={form.instance_base_url || "Same as the instance URL"}
                    className="font-mono text-xs"
                  />
                </FormField>
                <p className="text-xs text-muted-foreground">The test URL falls back to the instance URL when it is empty.</p>
              </div>
              <AgentTasksEditor
                tasks={form.tasks}
                errors={taskErrors}
                showErrors={showErrors}
                onChange={(tasks) => {
                  setForm((current) => ({ ...current, tasks }));
                  if (showErrors) setTaskErrors(taskFieldErrors(tasks));
                }}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3 border-t border-border/40 px-5 py-4 sm:px-8">
            {errors.save && <span className="flex-1 text-sm text-destructive">{errors.save}</span>}
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={() => setSheetOpen(false)}>Cancel</Button>
              <Button onClick={() => void handleSave()}>{editing ? "Save changes" : "Register agent"}</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog.Root open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-card p-6 shadow-xl">
            <Dialog.Title className="mb-1 text-sm font-semibold">Delete agent</Dialog.Title>
            <Dialog.Description className="mb-5 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{deleteTarget?.name}</span> will be permanently removed.
            </Dialog.Description>
            {deleteError != null && <p className="mb-3 text-sm text-destructive">{friendlyApiMessage(deleteError)}</p>}
            <div className="flex justify-end gap-2">
              <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
              <Button variant="destructive" onClick={() => void confirmDelete()}>Delete</Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <RunSheet agent={runAgent} onClose={() => setRunAgent(null)} />
    </Page>
  );
}

function AgentDetails({ agent }: { agent: Agent }) {
  return (
    <section className="space-y-3 rounded-2xl bg-card px-5 py-5 shadow-island">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{agent.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{agent.description || "No description."}</p>
        </div>
        <CopyIdButton id={agent.agent_id} label={`Copy id for ${agent.name}`} />
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">Endpoint </span>
        <span className="font-mono text-xs">{agent.instance.base_url}</span>
      </p>
      <ul className="space-y-1.5">
        {agent.tasks.map((task) => (
          <li key={task.task_id} className="flex items-center gap-2 text-sm">
            <span>{formatTaskLabel(task)}</span>
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{task.task_id}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RunSheet({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<RunPhase>("baseline");
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<FaultCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<unknown>(null);
  const [faultCode, setFaultCode] = useState(TASK_PRESET);
  const [faultTouched, setFaultTouched] = useState(false);
  const [fixes, setFixes] = useState<Set<FixKind>>(new Set(["pre_response_check"]));
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!agent) return;
    setPhase("baseline");
    setSelectedTasks(new Set(agent.tasks.map((task) => task.task_id)));
    setFaultTouched(false);
    setFixes(new Set(["pre_response_check"]));
    setError(null);
    setLaunching(false);
  }, [agent]);

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    listFaults()
      .then((next) => {
        if (!cancelled) {
          setCatalog(next);
          setCatalogError(null);
        }
      })
      .catch((cause) => {
        if (!cancelled) setCatalogError(cause);
      });
    return () => { cancelled = true; };
  }, [agent]);

  useEffect(() => {
    if (!catalog || faultTouched) return;
    setFaultCode(defaultFault(catalog, [...selectedTasks]));
  }, [catalog, selectedTasks, faultTouched]);

  function toggleTask(id: string) {
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleFix(kind: FixKind, checked: boolean) {
    setFixes((prev) => {
      const next = new Set(prev);
      if (checked) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }

  async function handleLaunch() {
    if (!agent) return;
    if (selectedTasks.size === 0) {
      setError(new Error("Select at least one task."));
      return;
    }
    if (phase === "after_fix" && fixes.size === 0) {
      setError(new Error("Choose at least one fix."));
      return;
    }
    setLaunching(true);
    setError(null);
    const params: RunParams = {
      agent_id: agent.agent_id,
      phase,
      task_ids: [...selectedTasks],
    };
    if (phase === "injected" || phase === "after_fix") {
      params.injection = injectionFor(faultCode, catalog);
    }
    if (phase === "after_fix") params.fix_kinds = fixKindsInOrder().filter((kind) => fixes.has(kind));
    try {
      const runs = await createRun(params);
      onClose();
      const first = runs[0];
      const traceId = first?.trace_ids[0];
      if (runs.length === 1 && traceId) navigate(`/traces/${encodeURIComponent(traceId)}`);
      else if (runs.length === 1 && first) navigate(`/runs/${encodeURIComponent(first.run_id)}`);
      else navigate("/runs");
    } catch (cause) {
      setError(cause);
    } finally {
      setLaunching(false);
    }
  }

  const needsFault = phase === "injected" || phase === "after_fix";

  return (
    <Sheet open={Boolean(agent)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="bottom" className="flex h-[80vh] flex-col rounded-t-2xl p-0">
        <div className="shrink-0 border-b border-border/40 px-5 pt-6 pb-5 sm:px-8">
          <p className="mb-0.5 text-xs text-muted-foreground">Launch run</p>
          <SheetTitle className="text-base font-medium tracking-tight">{agent?.name ?? ""}</SheetTitle>
        </div>
        <div className="flex flex-1 flex-col overflow-y-auto sm:flex-row sm:overflow-hidden">
          <div className="w-full shrink-0 space-y-3 border-b border-border/40 px-5 py-6 sm:w-[38%] sm:overflow-y-auto sm:border-r sm:border-b-0 sm:px-8">
            <p className="text-sm font-medium">Phase</p>
            <div className="flex flex-col gap-2" role="radiogroup" aria-label="Phase">
              {PHASES.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={phase === item}
                  onClick={() => setPhase(item)}
                  className={cn(
                    "rounded-xl border px-4 py-2.5 text-left text-sm transition-colors",
                    phase === item ? "border-foreground bg-foreground text-background" : "border-border text-foreground hover:border-foreground/40",
                  )}
                >
                  {PHASE_LABEL[item]}
                </button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">{PHASE_DESCRIPTION[phase]}</p>
          </div>
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-6 sm:px-8">
            <div className="space-y-2">
              <p className="text-sm font-medium">Tasks</p>
              {(agent?.tasks ?? []).map((task) => {
                const id = `launch-${task.task_id}`;
                return (
                  <label key={task.task_id} htmlFor={id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-border/40 px-4 py-3 hover:bg-muted/30">
                    <Checkbox id={id} checked={selectedTasks.has(task.task_id)} onCheckedChange={() => toggleTask(task.task_id)} />
                    <span className="text-sm">{formatTaskLabel(task)}</span>
                    <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{task.task_id}</span>
                  </label>
                );
              })}
            </div>
            {needsFault && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Fault</p>
                {catalogError != null && (
                  <div className="space-y-2">
                    <p className="text-sm text-destructive">{friendlyApiMessage(catalogError)}</p>
                    <Button size="sm" variant="outline" className="rounded-full" onClick={() => setRunAgentReload(agent, setCatalog, setCatalogError)}>
                      Retry
                    </Button>
                  </div>
                )}
                <Select
                  value={faultCode}
                  onValueChange={(value) => {
                    if (!value) return;
                    setFaultTouched(true);
                    setFaultCode(value);
                  }}
                >
                  <SelectTrigger aria-label="Fault">
                    <SelectValue>
                      {(value: string | null) => faultOptionLabel(value, catalog)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={TASK_PRESET}>Each task&apos;s preset</SelectItem>
                    {phase === "after_fix" && <SelectItem value={NO_FAULT}>No fault</SelectItem>}
                    {(catalog?.faults ?? []).map((fault) => (
                      <SelectItem key={fault.code} value={fault.code}>
                        {faultCodeLabel(fault.code)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FaultHint code={faultCode} catalog={catalog} />
              </div>
            )}
            {phase === "after_fix" && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Fixes</legend>
                {fixKindsInOrder().map((kind) => {
                  const id = `fix-${kind}`;
                  return (
                    <label key={kind} htmlFor={id} className="flex items-start gap-2 text-sm">
                      <Checkbox
                        id={id}
                        className="mt-0.5"
                        checked={fixes.has(kind)}
                        onCheckedChange={(checked) => toggleFix(kind, checked)}
                      />
                      <span>
                        <CodeTip label={FIX_LABEL[kind]} code={kind} />
                        <span className="mt-0.5 block text-muted-foreground">{FIX_DESCRIPTION[kind]}</span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t border-border/40 px-5 py-4 sm:px-8">
          {error != null && <span className="flex-1 text-sm text-destructive">{friendlyApiMessage(error)}</span>}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={launching}>Cancel</Button>
            <Button onClick={() => void handleLaunch()} disabled={launching || selectedTasks.size === 0 || (phase === "after_fix" && fixes.size === 0)}>
              {launching ? "Launching…" : "Launch run"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function setRunAgentReload(
  agent: Agent | null,
  setCatalog: (catalog: FaultCatalog) => void,
  setCatalogError: (error: unknown) => void,
) {
  if (!agent) return;
  listFaults().then(setCatalog).catch(setCatalogError);
}

function defaultFault(catalog: FaultCatalog, taskIds: string[]): string {
  const codes = [...new Set(taskIds.map((id) => catalog.presets[id]).filter((code): code is string => Boolean(code)))];
  return codes.length === 1 ? codes[0]! : TASK_PRESET;
}

function injectionFor(code: string, catalog: FaultCatalog | null): RunInjection {
  if (code === NO_FAULT) return null;
  if (code === TASK_PRESET || !catalog) return "preset";
  const entry = catalog.faults.find((fault) => fault.code === code);
  if (!entry) return "preset";
  const category = entry.category as FaultCategory;
  return {
    fault: entry.fault,
    target: entry.target,
    ground_truth: { category, code: entry.code },
  };
}

function faultOptionLabel(value: string | null, catalog: FaultCatalog | null): string {
  if (!value || value === TASK_PRESET) return "Each task's preset";
  if (value === NO_FAULT) return "No fault";
  const entry = catalog?.faults.find((fault) => fault.code === value);
  return entry ? faultCodeLabel(entry.code) : faultCodeLabel(value);
}

function FaultHint({ code, catalog }: { code: string; catalog: FaultCatalog | null }) {
  if (code === NO_FAULT) return <p className="text-sm text-muted-foreground">The replay does not inject a fault.</p>;
  if (code === TASK_PRESET) return <p className="text-sm text-muted-foreground">Each selected task uses its catalog preset.</p>;
  const entry = catalog?.faults.find((fault) => fault.code === code);
  if (!entry) return null;
  return <p className="text-sm text-muted-foreground">{entry.fault}</p>;
}

function FormField({
  label,
  error,
  required,
  children,
}: {
  label: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
