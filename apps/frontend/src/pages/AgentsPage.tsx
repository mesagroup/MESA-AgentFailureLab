import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Pencil, Play, PlusCircle, Search, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { canDeleteAgent, canEditAgent } from "@/lib/agents-page";
import { createRun, deleteAgent, listAgents, saveAgent, updateAgent, type AgentDraft, type RunParams } from "@/lib/api";
import {
  emptyOtelDraft,
  otelDraftFromAgent,
  otelSourceErrors,
  otelSourceFromDraft,
  otelSourceHasErrors,
  type OtelSourceDraft,
  type OtelSourceFieldError,
} from "@/lib/otel";
import type { Agent, AgentInstanceKind, AgentTask, OtelSourceAuthType, RunPhase } from "@mesa/shared";
import { AgentTasksEditor, blankTasks, validateTasks } from "@/pages/AgentTasksEditor";
import { OtelImportPanel } from "@/pages/OtelImportPanel";

interface FormState {
  name: string;
  description: string;
  instance_base_url: string;
  test_instance_base_url: string;
  instance_kind: AgentInstanceKind;
  tasks: AgentTask[];
  otel: OtelSourceDraft;
}

interface FormErrors {
  name?: string;
  instance_base_url?: string;
  tasks?: string;
  save?: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  instance_base_url: "",
  test_instance_base_url: "",
  instance_kind: "external",
  tasks: blankTasks(),
  otel: emptyOtelDraft(),
};

function agentToForm(agent: Agent): FormState {
  return {
    name: agent.name,
    description: agent.description,
    instance_base_url: agent.instance.base_url,
    test_instance_base_url: agent.test_instance.base_url,
    instance_kind: agent.instance.kind,
    tasks: structuredClone(agent.tasks),
    otel: otelDraftFromAgent(agent.otel),
  };
}

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [query, setQuery] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [otelErrors, setOtelErrors] = useState<OtelSourceFieldError>({});
  const [showErrors, setShowErrors] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [runAgent, setRunAgent] = useState<Agent | null>(null);
  const [importAgent, setImportAgent] = useState<Agent | null>(null);

  async function reload() {
    setAgents(await listAgents());
  }

  useEffect(() => { void reload(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) => a.name.toLowerCase().includes(q) || a.agent_id.toLowerCase().includes(q)
    );
  }, [agents, query]);

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY_FORM, tasks: blankTasks(), otel: emptyOtelDraft() });
    setErrors({});
    setOtelErrors({});
    setShowErrors(false);
    setSheetOpen(true);
  }

  function openEdit(agent: Agent) {
    setEditing(agent);
    setForm(agentToForm(agent));
    setErrors({});
    setOtelErrors({});
    setShowErrors(false);
    setSheetOpen(true);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await deleteAgent(deleteTarget.agent_id);
    setDeleteTarget(null);
    await reload();
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (key === "name" || key === "instance_base_url") {
      setErrors((e) => ({ ...e, [key]: undefined }));
    }
  }

  function validate(): boolean {
    const errs: FormErrors = {};
    if (!form.name.trim()) errs.name = "Name is required";
    if (!form.instance_base_url.trim()) errs.instance_base_url = "Instance URL is required";
    const taskError = validateTasks(form.tasks);
    if (taskError) errs.tasks = taskError;
    const nextOtelErrors = otelSourceErrors(form.otel);
    setErrors(errs);
    setOtelErrors(nextOtelErrors);
    setShowErrors(true);
    return Object.keys(errs).length === 0 && !otelSourceHasErrors(nextOtelErrors);
  }

  async function handleSave() {
    if (!validate()) return;
    const draft: AgentDraft = {
      name: form.name.trim(),
      description: form.description.trim(),
      instance_base_url: form.instance_base_url.trim(),
      test_instance_base_url: form.test_instance_base_url.trim(),
      instance_kind: form.instance_kind,
      tasks: form.tasks,
      otel: otelSourceFromDraft(form.otel) ?? null,
    };
    try {
      if (editing) {
        await updateAgent(editing.agent_id, draft);
      } else {
        await saveAgent(draft);
      }
      await reload();
      setSheetOpen(false);
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        save: e instanceof Error ? e.message : "Save failed",
      }));
    }
  }

  return (
    <div className="px-5 pb-8 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between pt-2 pb-2">
        <div>
          <h1 className="text-xl font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Registered agents · Track 03 CHAOS.AI</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 rounded-full"
          onClick={openCreate}
        >
          <PlusCircle className="h-3.5 w-3.5" />
          New agent
        </Button>
      </div>

      {/* Search island */}
      <div className="rounded-2xl bg-card shadow-island">
        <div className="flex items-center gap-2.5 px-5 py-3.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or ID…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/40"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              clear
            </button>
          )}
        </div>
      </div>

      {/* Count */}
      <div className="flex justify-end px-1">
        <span className="text-xs text-muted-foreground">
          {query
            ? `${filtered.length} of ${agents.length} agent${agents.length !== 1 ? "s" : ""}`
            : `${agents.length} agent${agents.length !== 1 ? "s" : ""}`}
        </span>
      </div>

      {/* List island */}
      <div className="rounded-2xl bg-card shadow-island overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {query ? <>No agents match <span className="font-mono">"{query}"</span></> : "No agents registered yet."}
          </div>
        ) : (
          <div>
            {filtered.map((agent) => {
              const isReference = agent.instance.kind === "reference";
              return (
                <div
                  key={agent.agent_id}
                  className="group flex items-center gap-4 px-5 py-3.5 border-b border-border/30 last:border-0 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium">{agent.name}</span>
                      <span className={cn(
                        "text-xs font-mono",
                        isReference ? "text-ring/70" : "text-muted-foreground/60"
                      )}>
                        {isReference ? "ref" : "ext"}
                      </span>
                    </div>
                    <p className="text-xs font-mono text-muted-foreground/60 truncate mt-0.5">
                      {agent.agent_id}
                    </p>
                  </div>

                  <span className="hidden sm:block font-mono text-xs text-muted-foreground/60 truncate max-w-[260px]">
                    {agent.instance.base_url}
                  </span>

                  <span className="text-xs text-muted-foreground/60 shrink-0 text-right">
                    {agent.tasks.length} task{agent.tasks.length !== 1 ? "s" : ""}
                    {agent.tasks.some((task) => task.evalset) ? " · evalset" : ""}
                    {agent.otel ? " · otel" : ""}
                  </span>

                  <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button size="icon-sm" variant="ghost" onClick={() => setImportAgent(agent)} title="Import OTel spans">
                      <Upload className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => setRunAgent(agent)} title="Launch run">
                      <Play className="h-3.5 w-3.5" />
                    </Button>
                    {canEditAgent(agent.agent_id) && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => openEdit(agent)}
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {canDeleteAgent(agent.agent_id) && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => setDeleteTarget(agent)}
                        title="Delete"
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create / Edit sheet */}
      <Sheet open={sheetOpen} onOpenChange={(open: boolean) => setSheetOpen(open)}>
        <SheetContent side="bottom" className="flex flex-col h-[95vh] rounded-t-2xl p-0">
          <div className="shrink-0 flex items-start justify-between px-8 pt-6 pb-5 border-b border-border/40">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">
                {editing ? "Editing agent" : "New agent"}
              </p>
              <SheetTitle className="font-mono text-base font-medium tracking-tight">
                {editing ? editing.agent_id : "configure"}
              </SheetTitle>
            </div>
          </div>

          <div className="flex flex-1 overflow-hidden">
            {/* Left — identity */}
            <div className="w-[38%] shrink-0 overflow-y-auto px-8 py-6 space-y-5 border-r border-border/40">
              <FormField label="Name" error={errors.name} required>
                <Input
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  placeholder="My shopping agent"
                  aria-invalid={!!errors.name}
                />
              </FormField>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">Kind</label>
                <div className="flex gap-1 mt-1">
                  {(["external", "reference"] as AgentInstanceKind[]).map((k) => {
                    const active = form.instance_kind === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setField("instance_kind", k)}
                        className={cn(
                          "px-3 py-1 rounded-full text-sm border transition-colors",
                          active
                            ? "bg-foreground text-background border-foreground"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
                        )}
                      >
                        {k}
                      </button>
                    );
                  })}
                </div>
              </div>

              <FormField label="Description">
                <textarea
                  value={form.description}
                  onChange={(e) => setField("description", e.target.value)}
                  placeholder="What does this agent do?"
                  rows={4}
                  className="w-full rounded-none border-0 border-b border-border/60 bg-transparent px-0 py-1 text-sm placeholder:text-muted-foreground/50 focus-visible:border-foreground focus-visible:outline-none resize-none transition-[color,border-color]"
                />
              </FormField>
            </div>

            {/* Right — endpoints + tasks */}
            <div className="flex-1 overflow-y-auto px-8 py-6 space-y-7">
              <div>
                <p className="text-xs text-muted-foreground mb-3">Endpoints</p>
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-16 shrink-0 text-right">Instance</span>
                    <div className="flex-1">
                      <Input
                        value={form.instance_base_url}
                        onChange={(e) => setField("instance_base_url", e.target.value)}
                        placeholder="http://127.0.0.1:3002"
                        className="font-mono text-xs"
                        aria-invalid={!!errors.instance_base_url}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-16 shrink-0 text-right">Test</span>
                    <div className="flex-1">
                      <Input
                        value={form.test_instance_base_url}
                        onChange={(e) => setField("test_instance_base_url", e.target.value)}
                        placeholder={form.instance_base_url || "http://127.0.0.1:3002"}
                        className="font-mono text-xs"
                      />
                    </div>
                  </div>
                  {errors.instance_base_url && (
                    <p className="text-xs text-destructive pl-[76px]">{errors.instance_base_url}</p>
                  )}
                  <p className="text-xs text-muted-foreground pl-[76px]">Test defaults to instance URL if empty.</p>
                </div>
              </div>

              <OtelSourceFields
                draft={form.otel}
                errors={otelErrors}
                showErrors={showErrors}
                onChange={(key, value) => {
                  const otel = { ...form.otel, [key]: value };
                  setForm((current) => ({ ...current, otel }));
                  if (showErrors) setOtelErrors(otelSourceErrors(otel));
                }}
              />

              <AgentTasksEditor
                tasks={form.tasks}
                showErrors={showErrors}
                onChange={(tasks) => {
                  setForm((current) => ({ ...current, tasks }));
                  setErrors((current) => ({
                    ...current,
                    tasks: showErrors ? validateTasks(tasks) : undefined,
                  }));
                }}
              />
              {errors.tasks && <p className="text-xs text-destructive">{errors.tasks}</p>}
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-3 px-8 py-4 border-t border-border/40">
            {errors.save && (
              <span className="text-xs text-destructive flex-1">{errors.save}</span>
            )}
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={() => setSheetOpen(false)}>Cancel</Button>
              <Button onClick={handleSave}>
                {editing ? "Save changes" : "Register agent"}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete confirm dialog */}
      <Dialog.Root open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-card p-6 shadow-xl transition duration-150 data-ending-style:opacity-0 data-ending-style:scale-95 data-starting-style:opacity-0 data-starting-style:scale-95">
            <Dialog.Title className="text-sm font-semibold mb-1">Delete agent</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground mb-5">
              <span className="font-medium text-foreground">{deleteTarget?.name}</span> will be permanently removed.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
              <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <RunSheet
        agent={runAgent}
        onClose={() => setRunAgent(null)}
      />

      <Sheet open={!!importAgent} onOpenChange={(open) => { if (!open) setImportAgent(null); }}>
        <SheetContent side="bottom" className="flex flex-col h-[72vh] rounded-t-2xl p-0">
          <div className="shrink-0 px-8 pt-6 pb-4 border-b border-border/40">
            <p className="text-xs text-muted-foreground mb-0.5">Import OTel spans</p>
            <SheetTitle className="font-mono text-base font-medium tracking-tight">
              {importAgent?.name ?? ""}
            </SheetTitle>
          </div>
          <div className="flex-1 overflow-y-auto px-8 py-6">
            {importAgent ? <OtelImportPanel agentId={importAgent.agent_id} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function OtelSourceFields({
  draft,
  errors,
  showErrors,
  onChange,
}: {
  draft: OtelSourceDraft;
  errors: OtelSourceFieldError;
  showErrors: boolean;
  onChange: <K extends keyof OtelSourceDraft>(key: K, value: OtelSourceDraft[K]) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={draft.enabled}
          onChange={(event) => onChange("enabled", event.target.checked)}
        />
        <span>
          <span className="font-medium">OTel source</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Documents where spans come from. The importer does not call this endpoint. A bearer token stays in the named env var and is not stored here. Version 1.
          </span>
        </span>
      </label>
      {draft.enabled && (
        <div className="space-y-3">
          <FormField label="OTLP traces URL" error={showErrors ? errors.endpoint : undefined} required>
            <Input
              value={draft.endpoint}
              onChange={(event) => onChange("endpoint", event.target.value)}
              placeholder="https://otel.example.com/v1/traces"
              className="font-mono text-xs"
              aria-invalid={showErrors && Boolean(errors.endpoint)}
            />
          </FormField>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Auth</label>
            <div className="flex gap-1">
              {(["none", "bearer"] as OtelSourceAuthType[]).map((authType) => {
                const active = draft.authType === authType;
                return (
                  <button
                    key={authType}
                    type="button"
                    onClick={() => onChange("authType", authType)}
                    className={cn(
                      "px-3 py-1 rounded-full text-sm border transition-colors",
                      active
                        ? "bg-foreground text-background border-foreground"
                        : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40",
                    )}
                  >
                    {authType === "bearer" ? "Bearer env var" : "None"}
                  </button>
                );
              })}
            </div>
          </div>
          {draft.authType === "bearer" && (
            <FormField
              label="Token env var"
              error={showErrors ? errors.token_env : undefined}
              required
            >
              <Input
                value={draft.tokenEnv}
                onChange={(event) => onChange("tokenEnv", event.target.value)}
                placeholder="OTEL_SOURCE_TOKEN"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                aria-invalid={showErrors && Boolean(errors.token_env)}
              />
              <p className="text-xs text-muted-foreground">Name only, such as OTEL_SOURCE_TOKEN. Do not paste the token.</p>
            </FormField>
          )}
          <FormField label="Service name" error={showErrors ? errors.service_name : undefined}>
            <Input
              value={draft.serviceName}
              onChange={(event) => onChange("serviceName", event.target.value)}
              placeholder="reference-shop"
              className="font-mono text-xs"
              aria-invalid={showErrors && Boolean(errors.service_name)}
            />
            <p className="text-xs text-muted-foreground">Optional. When set, every imported item must use this name.</p>
          </FormField>
        </div>
      )}
    </div>
  );
}

function RunSheet({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const [phase, setPhase] = useState<RunPhase>("baseline");
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agent) {
      setPhase("baseline");
      setSelectedTasks(new Set(agent.tasks.map((t) => t.task_id)));
      setError(null);
      setLaunching(false);
    }
  }, [agent]);

  function toggleTask(id: string) {
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleLaunch() {
    if (!agent) return;
    if (selectedTasks.size === 0) { setError("Select at least one task."); return; }
    setLaunching(true);
    setError(null);
    try {
      const params: RunParams = { agent_id: agent.agent_id, phase, task_ids: [...selectedTasks] };
      await createRun(params);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Launch failed.");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <Sheet open={!!agent} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="bottom" className="flex flex-col h-[72vh] rounded-t-2xl p-0">
        <div className="shrink-0 px-8 pt-6 pb-5 border-b border-border/40">
          <p className="text-xs text-muted-foreground mb-0.5">Launch run</p>
          <SheetTitle className="font-mono text-base font-medium tracking-tight">{agent?.name ?? ""}</SheetTitle>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="w-[38%] shrink-0 border-r border-border/40 px-8 py-6">
            <p className="text-sm font-medium mb-3">Phase</p>
            <div className="flex flex-col gap-2">
              {(["baseline", "injected", "after_fix"] as RunPhase[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPhase(p)}
                  className={cn(
                    "text-left px-4 py-2.5 rounded-xl border text-sm transition-colors",
                    phase === p
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
                  )}
                >
                  <span className="font-mono">{p}</span>
                </button>
              ))}
            </div>
            {phase === "after_fix" && (
              <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                after_fix needs fix_kinds from a diagnosis. Select proposed fixes on the trace timeline, then replay.
              </p>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-8 py-6">
            <p className="text-sm font-medium mb-3">Tasks</p>
            <div className="space-y-2">
              {(agent?.tasks ?? []).map((task) => (
                <label
                  key={task.task_id}
                  className="flex items-center gap-3 rounded-xl border border-border/40 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selectedTasks.has(task.task_id)}
                    onChange={() => toggleTask(task.task_id)}
                    className="accent-primary shrink-0"
                  />
                  <span className="font-mono text-xs text-muted-foreground w-32 shrink-0 truncate">{task.task_id}</span>
                  <span className="text-sm">{task.title}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-3 px-8 py-4 border-t border-border/40">
          {error && <span className="text-xs text-destructive flex-1">{error}</span>}
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" onClick={onClose} disabled={launching}>Cancel</Button>
            <Button onClick={handleLaunch} disabled={launching || selectedTasks.size === 0}>
              {launching ? "Launching…" : "Launch run"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
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
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
