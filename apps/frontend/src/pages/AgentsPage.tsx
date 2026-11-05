import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Pencil, Play, PlusCircle, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { canDeleteAgent, deleteAgentErrorMessage, hrefAfterCreateRun, hrefAfterJuryLaunch, isLoopback } from "@/lib/agents-page";
import { createRun, deleteAgent, getHarnessSnapshot, getJuryCase, listAgents, postJuryCase, saveAgent, updateAgent, type AgentDraft } from "@/lib/api";
import { PromptLaunchEditor, launchPromptOverride } from "@/lib/prompt-launch-editor";
import {
  emptyOtelDraft,
  otelDraftFromAgent,
  otelSourceErrors,
  otelSourceFromDraft,
  otelSourceHasErrors,
  type OtelSourceDraft,
  type OtelSourceFieldError,
} from "@/lib/otel";
import {
  FIX_KINDS,
  JURY_LAUNCH_COPY,
  LAUNCH_PHASE_COPY,
  LAUNCH_PHASES,
  baselineRunsForAgent,
  buildLaunchRequest,
  filterRunsByQuery,
  formatRunDuration,
  PROMPT_LAUNCH_COPY,
  juryLaunchMode,
  juryReferenceRunsForAgent,
  jurySheetReady,
  phaseNeedsReferenceRun,
  promptHistoryEntries,
  runPhaseLabel,
  storedPhaseForLaunch,
  type PromptHistoryEntry,
  taskForRun,
  taskTitleForRun,
  toggleLaunchFixKind,
  type LaunchPhase,
} from "@/lib/run-launch";
import {
  formDefaults,
  isWorldBusy,
  noteMaxChars,
  permissionChoices,
  type JuryCaseDescription,
} from "@/lib/jury";
import type { Agent, AgentTask, FixKind, Run } from "@mesa/shared";
import { AgentTasksEditor, blankTasks, validateTasks } from "@/pages/AgentTasksEditor";
import { OtelImportPanel } from "@/pages/OtelImportPanel";
import { TracePullPanel } from "@/pages/TracePullPanel";

type AgentEditTab = "endpoints" | "otel" | "tasks";

interface FormState {
  name: string;
  description: string;
  instance_base_url: string;
  test_instance_base_url: string;
  github_repo_url: string;
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
  github_repo_url: "",
  tasks: blankTasks(),
  otel: emptyOtelDraft(),
};

const EDIT_TABS: { id: AgentEditTab; label: string }[] = [
  { id: "endpoints", label: "Endpoints" },
  { id: "otel", label: "OTel" },
  { id: "tasks", label: "Tasks" },
];

function agentToForm(agent: Agent): FormState {
  return {
    name: agent.name,
    description: agent.description,
    instance_base_url: agent.instance.base_url,
    test_instance_base_url: agent.test_instance.base_url,
    github_repo_url: agent.github_repo_url ?? "",
    tasks: structuredClone(agent.tasks),
    otel: otelDraftFromAgent(agent.otel),
  };
}

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [otelErrors, setOtelErrors] = useState<OtelSourceFieldError>({});
  const [showErrors, setShowErrors] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [runAgent, setRunAgent] = useState<Agent | null>(null);
  const [pullAgent, setPullAgent] = useState<Agent | null>(null);
  const [editTab, setEditTab] = useState<AgentEditTab>("endpoints");

  async function reload() {
    setAgents(await listAgents());
  }

  useEffect(() => {
    void listAgents().then((data) => {
      setAgents(data);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, []);

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
    setEditTab("endpoints");
    setSheetOpen(true);
  }

  function openEdit(agent: Agent) {
    setEditing(agent);
    setForm(agentToForm(agent));
    setErrors({});
    setOtelErrors({});
    setShowErrors(false);
    setEditTab("endpoints");
    setSheetOpen(true);
  }

  function openDelete(agent: Agent) {
    setDeleteError(null);
    setDeleting(false);
    setDeleteTarget(agent);
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAgent(deleteTarget.agent_id);
      setDeleteTarget(null);
      await reload();
    } catch (error) {
      setDeleteError(deleteAgentErrorMessage(error, deleteTarget.agent_id));
    } finally {
      setDeleting(false);
    }
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
    const otelBad = otelSourceHasErrors(nextOtelErrors);
    if (errs.instance_base_url) setEditTab("endpoints");
    else if (otelBad) setEditTab("otel");
    else if (errs.tasks) setEditTab("tasks");
    return Object.keys(errs).length === 0 && !otelBad;
  }

  async function handleSave() {
    if (!validate()) return;
    const draft: AgentDraft = {
      name: form.name.trim(),
      description: form.description.trim(),
      instance_base_url: form.instance_base_url.trim(),
      test_instance_base_url: form.test_instance_base_url.trim(),
      github_repo_url: form.github_repo_url.trim() || undefined,
      tasks: form.tasks,
      otel: otelSourceFromDraft(form.otel, {
        preserveSchemaId: editing?.otel?.schema_id,
      }) ?? null,
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
      {!loading && (
        <div className="flex justify-end px-1">
          <span className="text-xs text-muted-foreground">
            {query
              ? `${filtered.length} of ${agents.length} agent${agents.length !== 1 ? "s" : ""}`
              : `${agents.length} agent${agents.length !== 1 ? "s" : ""}`}
          </span>
        </div>
      )}

      {/* List island */}
      <div className="rounded-2xl bg-card shadow-island overflow-hidden">
        {loading ? (
          <div className="p-5 space-y-3">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {query ? <>No agents match <span className="font-mono">"{query}"</span></> : "No agents registered yet."}
          </div>
        ) : (
          <div>
            {filtered.map((agent) => (
                <div
                  key={agent.agent_id}
                  className="group flex items-center gap-4 px-5 py-3.5 border-b border-border/30 last:border-0 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{agent.name}</span>
                    <p className="text-xs font-mono text-muted-foreground/60 truncate mt-0.5">
                      {agent.agent_id}
                    </p>
                  </div>

                  <span className="hidden sm:flex items-center gap-1.5 min-w-0 max-w-[260px]">
                    <span className="font-mono text-xs text-muted-foreground/60 truncate">{agent.instance.base_url}</span>
                    {isLoopback(agent.instance.base_url) && (
                      <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">local</span>
                    )}
                  </span>

                  <span className="text-xs text-muted-foreground/60 shrink-0 text-right">
                    {agent.tasks.length} task{agent.tasks.length !== 1 ? "s" : ""}
                    {agent.tasks.some((task) => task.evalset) ? " · evalset" : ""}
                    {agent.otel ? " · otel" : ""}
                  </span>

                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => setPullAgent(agent)} title="Pull traces">
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span className="hidden md:inline">Pull</span>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRunAgent(agent)} title="Launch run">
                      <Play className="h-3.5 w-3.5" />
                      <span className="hidden md:inline">Run</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEdit(agent)}
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      <span className="hidden md:inline">Edit</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openDelete(agent)}
                      title="Delete"
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="hidden md:inline">Delete</span>
                    </Button>
                  </div>
                </div>
            ))}
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

          <div className="flex flex-1 flex-col md:flex-row overflow-hidden">
            {/* Left — identity */}
            <div className="md:w-[38%] shrink-0 overflow-y-auto px-8 py-6 space-y-5 border-b md:border-b-0 md:border-r border-border/40">
              <FormField label="Name" error={errors.name} required>
                <Input
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  placeholder="My shopping agent"
                  aria-invalid={!!errors.name}
                />
              </FormField>

              <FormField label="Description">
                <textarea
                  value={form.description}
                  onChange={(e) => setField("description", e.target.value)}
                  placeholder="What does this agent do?"
                  rows={7}
                  className="w-full rounded-none border-0 border-b border-border/60 bg-transparent px-0 py-1 text-sm placeholder:text-muted-foreground/50 focus-visible:border-foreground focus-visible:outline-none resize-none transition-[color,border-color]"
                />
              </FormField>
            </div>

            {/* Right — tabbed endpoints / otel / tasks */}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="shrink-0 flex gap-1 px-8 pt-4 border-b border-border/40" role="tablist" aria-label="Agent settings">
                {EDIT_TABS.map((tab) => {
                  const active = editTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setEditTab(tab.id)}
                      className={cn(
                        "px-3 py-2 text-sm border-b-2 -mb-px transition-colors",
                        active
                          ? "border-foreground text-foreground font-medium"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              <div className="flex-1 overflow-y-auto px-8 py-6">
                <div className={cn("space-y-2", editTab !== "endpoints" && "hidden")}>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-16 shrink-0 text-right">Instance</span>
                    <div className="flex-1">
                      <Input
                        value={form.instance_base_url}
                        onChange={(e) => setField("instance_base_url", e.target.value)}
                        placeholder="https://your-agent.onrender.com"
                        className="font-mono text-xs"
                        aria-invalid={!!errors.instance_base_url}
                      />
                    </div>
                  </div>
                  {isLoopback(form.instance_base_url) && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 pl-[76px]">
                      Loopback addresses are unreachable from the lab server in production. Use a public URL (e.g. https://…onrender.com).
                    </p>
                  )}
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-16 shrink-0 text-right">Test</span>
                    <div className="flex-1">
                      <Input
                        value={form.test_instance_base_url}
                        onChange={(e) => setField("test_instance_base_url", e.target.value)}
                        placeholder={form.instance_base_url || "https://your-agent.onrender.com"}
                        className="font-mono text-xs"
                      />
                    </div>
                  </div>
                  {isLoopback(form.test_instance_base_url) && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 pl-[76px]">
                      Loopback addresses are unreachable from the lab server in production. Use a public URL (e.g. https://…onrender.com).
                    </p>
                  )}
                  {errors.instance_base_url && (
                    <p className="text-xs text-destructive pl-[76px]">{errors.instance_base_url}</p>
                  )}
                  <p className="text-xs text-muted-foreground pl-[76px]">Test defaults to instance URL if empty.</p>
                  <div className="flex items-center gap-3 pt-2">
                    <span className="text-xs text-muted-foreground w-16 shrink-0 text-right">GitHub</span>
                    <div className="flex-1">
                      <Input
                        value={form.github_repo_url}
                        onChange={(e) => setField("github_repo_url", e.target.value)}
                        placeholder="https://github.com/org/repo"
                        className="font-mono text-xs"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground pl-[76px]">Optional. Used to open diagnoses as GitHub issues.</p>
                </div>

                <div className={cn("space-y-7", editTab !== "otel" && "hidden")}>
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
                  {editing ? (
                    <div className="space-y-3 border-t border-border/40 pt-6">
                      <p className="text-xs text-muted-foreground">Import JSON spans for this agent.</p>
                      <OtelImportPanel agentId={editing.agent_id} />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground border-t border-border/40 pt-6">
                      Save the agent, then import from Edit.
                    </p>
                  )}
                </div>

                <div className={cn("space-y-3", editTab !== "tasks" && "hidden")}>
                  <AgentTasksEditor
                    tasks={form.tasks}
                    docs={editing?.docs}
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
      <Dialog.Root
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-card p-6 shadow-xl transition duration-150 data-ending-style:opacity-0 data-ending-style:scale-95 data-starting-style:opacity-0 data-starting-style:scale-95">
            <Dialog.Title className="text-sm font-semibold mb-1">Delete agent</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground mb-5">
              {deleteTarget && !canDeleteAgent(deleteTarget.agent_id) ? (
                <>
                  <span className="font-medium text-foreground">{deleteTarget.name}</span> is a demo seed.
                  DELETE returns 409 and the agent stays registered.
                </>
              ) : (
                <>
                  <span className="font-medium text-foreground">{deleteTarget?.name}</span> will be permanently removed.
                </>
              )}
            </Dialog.Description>
            {deleteError && <p className="text-xs text-destructive mb-4">{deleteError}</p>}
            <div className="flex justify-end gap-2">
              <Dialog.Close render={<Button variant="outline" disabled={deleting} />}>Cancel</Dialog.Close>
              <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <RunSheet
        agent={runAgent}
        onClose={() => setRunAgent(null)}
      />

      <Sheet open={!!pullAgent} onOpenChange={(open) => { if (!open) setPullAgent(null); }}>
        <SheetContent side="bottom" className="flex flex-col h-[72vh] rounded-t-2xl p-0">
          <div className="shrink-0 px-8 pt-6 pb-4 border-b border-border/40">
            <p className="text-xs text-muted-foreground mb-0.5">Pull traces</p>
            <SheetTitle className="font-mono text-base font-medium tracking-tight">
              {pullAgent?.name ?? ""}
            </SheetTitle>
          </div>
          <div className="flex-1 overflow-y-auto px-8 py-6">
            {pullAgent ? <TracePullPanel agent={pullAgent} /> : null}
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
            Dual prod and test traces URLs. Open lab: sources use auth none. Schema remap stays on the agent (ADR-001: remap does not invent verifier or fault labels). Version 1.
          </span>
        </span>
      </label>
      {draft.enabled && (
        <div className="space-y-3">
          <FormField label="Prod traces URL" error={showErrors ? errors.prod_endpoint : undefined} required>
            <Input
              value={draft.prodEndpoint}
              onChange={(event) => onChange("prodEndpoint", event.target.value)}
              placeholder="https://your-agent.onrender.com/internal/otel/traces?source=prod"
              className="font-mono text-xs"
              aria-invalid={showErrors && Boolean(errors.prod_endpoint)}
            />
          </FormField>
          <FormField label="Test traces URL" error={showErrors ? errors.test_endpoint : undefined} required>
            <Input
              value={draft.testEndpoint}
              onChange={(event) => onChange("testEndpoint", event.target.value)}
              placeholder="https://your-agent.onrender.com/internal/otel/traces?source=test"
              className="font-mono text-xs"
              aria-invalid={showErrors && Boolean(errors.test_endpoint)}
            />
          </FormField>
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
  const navigate = useNavigate();
  const [phase, setPhase] = useState<LaunchPhase>("baseline");
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [parentRunId, setParentRunId] = useState<string | null>(null);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [baselineFilter, setBaselineFilter] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [promptTouched, setPromptTouched] = useState(false);
  const [fixKinds, setFixKinds] = useState<FixKind[]>([]);
  const [juryFixKinds, setJuryFixKinds] = useState<FixKind[]>(["permission_guard"]);
  const [juryDescription, setJuryDescription] = useState<JuryCaseDescription | null>(null);
  const [juryLoading, setJuryLoading] = useState(false);
  const [juryLoadError, setJuryLoadError] = useState<string | null>(null);
  const [juryNote, setJuryNote] = useState("");
  const [juryPermissions, setJuryPermissions] = useState<string[]>([]);
  const [juryIncludeBaseline, setJuryIncludeBaseline] = useState(true);
  const [agentRuns, setAgentRuns] = useState<Run[]>([]);
  const [startedAtByRunId, setStartedAtByRunId] = useState<Record<string, string>>({});
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent) return;
    setPhase("baseline");
    setSelectedTasks(new Set(agent.tasks.map((t) => t.task_id)));
    setParentRunId(null);
    setDetailRunId(null);
    setBaselineFilter("");
    setPromptDraft("");
    setPromptTouched(false);
    setFixKinds([]);
    setJuryFixKinds(["permission_guard"]);
    setJuryDescription(null);
    setJuryLoadError(null);
    setJuryNote("");
    setJuryPermissions([]);
    setJuryIncludeBaseline(true);
    setError(null);
    setRunsError(null);
    setLaunching(false);
    let cancelled = false;
    setLoadingRuns(true);
    getHarnessSnapshot()
      .then((snapshot) => {
        if (!cancelled) {
          setAgentRuns(snapshot.runs);
          const times: Record<string, string> = {};
          for (const link of snapshot.trace_links) {
            const started = link.traces[0]?.started_at;
            if (started) times[link.run_id] = started;
          }
          setStartedAtByRunId(times);
          setRunsError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setAgentRuns([]);
          setStartedAtByRunId({});
          setRunsError(err instanceof Error ? err.message : "Could not load runs.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingRuns(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  const hasTestRun = useMemo(
    () =>
      !!agent &&
      agentRuns.some(
        (run) => run.agent_id === agent.agent_id && run.phase !== "after_fix",
      ),
    [agent, agentRuns],
  );

  const baselines = useMemo(
    () => (agent ? baselineRunsForAgent(agentRuns, agent.agent_id) : []),
    [agent, agentRuns],
  );

  const filteredBaselines = useMemo(() => {
    const filtered = filterRunsByQuery(baselines, agent, baselineFilter);
    if (!parentRunId) return filtered;
    if (filtered.some((run) => run.run_id === parentRunId)) return filtered;
    const selected = baselines.find((run) => run.run_id === parentRunId);
    return selected ? [selected, ...filtered] : filtered;
  }, [baselines, agent, baselineFilter, parentRunId]);

  const juryReferences = useMemo(
    () => (agent ? juryReferenceRunsForAgent(agentRuns, agent.agent_id) : []),
    [agent, agentRuns],
  );

  const filteredJuryReferences = useMemo(() => {
    const filtered = filterRunsByQuery(juryReferences, agent, baselineFilter);
    if (!parentRunId) return filtered;
    if (filtered.some((run) => run.run_id === parentRunId)) return filtered;
    const selected = juryReferences.find((run) => run.run_id === parentRunId);
    return selected ? [selected, ...filtered] : filtered;
  }, [juryReferences, agent, baselineFilter, parentRunId]);

  const selectedJuryRun = useMemo(
    () => juryReferences.find((run) => run.run_id === parentRunId) ?? null,
    [juryReferences, parentRunId],
  );
  const selectedJuryTask = useMemo(
    () => (selectedJuryRun && agent ? taskForRun(agent, selectedJuryRun) : undefined),
    [selectedJuryRun, agent],
  );
  const juryMode = juryLaunchMode(selectedJuryRun);
  const juryChoices = juryDescription ? permissionChoices(juryDescription) : [];
  const juryMaxChars = noteMaxChars(juryDescription);

  const selectedBaseline = useMemo(
    () => baselines.find((run) => run.run_id === parentRunId) ?? null,
    [baselines, parentRunId],
  );

  const selectedTask = useMemo(
    () => (selectedBaseline && agent ? taskForRun(agent, selectedBaseline) : undefined),
    [selectedBaseline, agent],
  );
  const selectedLaunchTask = phase === "jury" ? selectedJuryTask : selectedTask;
  const historyPhase = storedPhaseForLaunch(phase, juryMode);
  const promptHistory =
    agent && selectedLaunchTask && historyPhase
      ? promptHistoryEntries(
          agentRuns,
          agent.agent_id,
          selectedLaunchTask.task_id,
          historyPhase,
          startedAtByRunId,
        )
      : [];

  function toggleTask(id: string) {
    if (launching) return;
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    if (!agent || phase !== "jury") return;
    let cancelled = false;
    setJuryLoading(true);
    setJuryLoadError(null);
    getJuryCase()
      .then((description) => {
        if (cancelled) return;
        setJuryDescription(description);
        const defaults = formDefaults(description);
        setJuryNote((current) => (current.trim() ? current : defaults.note));
        setJuryPermissions((current) => (current.length > 0 ? current : defaults.permissions));
        setJuryIncludeBaseline(defaults.includeBaseline);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setJuryLoadError(err instanceof Error ? err.message : "Could not load the security case.");
      })
      .finally(() => {
        if (!cancelled) setJuryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent, phase]);

  function selectPhase(next: LaunchPhase) {
    setPhase(next);
    setError(null);
    if (!phaseNeedsReferenceRun(next)) {
      setParentRunId(null);
      setDetailRunId(null);
      setPromptDraft("");
      setPromptTouched(false);
    }
    if (next === "jury") setJuryFixKinds(["permission_guard"]);
  }

  function selectBaseline(runId: string) {
    setParentRunId(runId);
    setDetailRunId(runId);
    setPromptTouched(false);
    setError(null);
  }

  async function handleLaunch() {
    if (!agent || launching) return;
    const runPhase = phase === "injected" || phase === "after_fix" || phase === "jury";
    const built = buildLaunchRequest({
      agentId: agent.agent_id,
      phase,
      taskIds: [...selectedTasks],
      parentRunId,
      fixKinds: phase === "jury" ? juryFixKinds : fixKinds,
      promptOverride:
        runPhase ? launchPromptOverride(promptDraft, selectedLaunchTask?.prompt, promptTouched) : null,
      jury: {
        note: juryNote,
        permissions: juryPermissions,
        includeBaseline: juryIncludeBaseline,
        referenceRun: selectedJuryRun,
        maxChars: juryMaxChars,
      },
    });
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      if (built.kind === "jury") {
        const report = await postJuryCase(built.body);
        onClose();
        navigate(hrefAfterJuryLaunch(report));
      } else {
        const results = await createRun(built.params);
        const taskIds = results.map((r) => r.run.task_id).join(", ");
        toast.success(`Run launched — ${taskIds}`);
        onClose();
        navigate(hrefAfterCreateRun(results));
      }
    } catch (e) {
      const busyCode = juryDescription?.frontend?.http_409?.jury_and_runs;
      const msg = e instanceof Error ? e.message : "Launch failed.";
      if (phase === "jury" && isWorldBusy(e, busyCode)) {
        setError("The mock world is busy with another run. Retry when it finishes. This is not a verifier failure.");
      } else {
        setError(msg);
        toast.error(msg);
      }
    } finally {
      setLaunching(false);
    }
  }

  const promptOk =
    phase === "baseline" ||
    (!promptTouched && Boolean(selectedLaunchTask?.prompt)) ||
    promptDraft.trim().length > 0;
  const launchReady =
    phase === "baseline"
      ? selectedTasks.size > 0
      : phase === "injected"
        ? Boolean(parentRunId) && promptOk
        : phase === "jury"
          ? jurySheetReady({
              note: juryNote,
              referenceRun: selectedJuryRun,
              permissions: juryPermissions,
              includeBaseline: juryIncludeBaseline,
              fixKinds: juryFixKinds,
              maxChars: juryMaxChars,
            }) && !juryLoading && promptOk
        : Boolean(parentRunId) && fixKinds.length > 0 && promptOk;

  return (
    <Sheet open={!!agent} onOpenChange={(open) => { if (!open && !launching) onClose(); }}>
      <SheetContent side="bottom" className="flex flex-col h-[80vh] rounded-t-2xl p-0">
        <div className="shrink-0 px-8 pt-6 pb-5 border-b border-border/40">
          <p className="text-xs text-muted-foreground mb-0.5">Launch run</p>
          <SheetTitle className="font-mono text-base font-medium tracking-tight">{agent?.name ?? ""}</SheetTitle>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="w-[32%] shrink-0 border-r border-border/40 px-8 py-6">
            <p className="text-sm font-medium mb-3">Phase</p>
            <div className="flex flex-col gap-2" role="radiogroup" aria-label="Launch phase">
              {LAUNCH_PHASES.map((p) => {
                const phaseLocked = !hasTestRun && p !== "baseline";
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={launching || phaseLocked}
                    onClick={phaseLocked ? undefined : () => selectPhase(p)}
                    aria-pressed={phase === p}
                    aria-describedby={phaseLocked ? "phase-lock-hint" : undefined}
                    className={cn(
                      "text-left px-4 py-2.5 rounded-xl border text-sm transition-colors",
                      phaseLocked
                        ? "opacity-50 cursor-not-allowed border-border text-muted-foreground"
                        : phase === p
                          ? "bg-foreground text-background border-foreground"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 disabled:opacity-50"
                    )}
                  >
                    <span>{LAUNCH_PHASE_COPY[p].label}</span>
                    <span className="block text-[11px] mt-0.5 opacity-80">{LAUNCH_PHASE_COPY[p].subtitle}</span>
                  </button>
                );
              })}
            </div>
            {!hasTestRun && (
              <p id="phase-lock-hint" className="text-xs text-muted-foreground mt-3 leading-relaxed">
                Complete a baseline run first to unlock other phases.
              </p>
            )}
            {hasTestRun && phase === "injected" && (
              <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                Pick a completed baseline. Review the task prompt, edit it if needed, then inject.
              </p>
            )}
            {hasTestRun && phase === "after_fix" && (
              <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                Owner already fixed the agent on their deploy. Pick one baseline, edit the prompt if needed, choose fix kinds, then replay.
              </p>
            )}
            {hasTestRun && phase === "jury" && (
              <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                {JURY_LAUNCH_COPY.helper}
              </p>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6">
            {phase === "baseline" ? (
              <div>
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
            ) : phase === "jury" ? (
              <JuryLaunchFields
                agent={agent}
                launching={launching}
                loadingRuns={loadingRuns}
                runsError={runsError}
                juryLoading={juryLoading}
                juryLoadError={juryLoadError}
                filter={baselineFilter}
                onFilter={setBaselineFilter}
                references={filteredJuryReferences}
                totalReferences={juryReferences.length}
                selectedRunId={parentRunId}
                selectedRun={selectedJuryRun}
                detailRunId={detailRunId}
                onSelectRun={(runId) => {
                  if (launching) return;
                  setParentRunId(runId);
                  setDetailRunId(runId);
                  setPromptTouched(false);
                  setError(null);
                }}
                onToggleDetail={(runId) => {
                  if (launching) return;
                  setDetailRunId((prev) => (prev === runId ? null : runId));
                  if (parentRunId !== runId) {
                    setParentRunId(runId);
                    setPromptTouched(false);
                    setError(null);
                  }
                }}
                promptTask={selectedJuryTask}
                promptHistory={promptHistory}
                onDraftChange={(draft, touched) => {
                  setPromptDraft(draft);
                  setPromptTouched(touched);
                }}
                note={juryNote}
                onNote={setJuryNote}
                maxChars={juryMaxChars}
                permissions={juryPermissions}
                choices={juryChoices.length > 0 ? juryChoices : ["read", "write:cart", "write:order", "write:order:cancel"]}
                onTogglePermission={(permission) => {
                  if (launching) return;
                  setJuryPermissions((prev) => (
                    prev.includes(permission)
                      ? prev.filter((name) => name !== permission)
                      : [...prev, permission]
                  ));
                }}
                includeBaseline={juryIncludeBaseline}
                onIncludeBaseline={setJuryIncludeBaseline}
                mode={juryMode}
                fixKinds={juryFixKinds}
                onToggleFixKind={(kind) => {
                  if (launching) return;
                  setJuryFixKinds((prev) => toggleLaunchFixKind(prev, kind));
                }}
              />
            ) : (
              <>
                <div>
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <p className="text-sm font-medium">
                      {phase === "injected" ? "Baseline run to inject" : "Baseline run to replay"}
                    </p>
                    <span className="text-xs text-muted-foreground">
                      {filteredBaselines.length}/{baselines.length}
                    </span>
                  </div>
                  {loadingRuns ? (
                    <p className="text-xs text-muted-foreground">Loading baselines…</p>
                  ) : runsError ? (
                    <p className="text-xs text-destructive">{runsError}</p>
                  ) : baselines.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No completed baseline runs for this agent. Launch a baseline first.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
                        <Input
                          value={baselineFilter}
                          onChange={(event) => setBaselineFilter(event.target.value)}
                          placeholder="Filter by title, task, status, prompt…"
                          className="pl-9 h-9 text-sm"
                          aria-label="Filter baseline runs"
                        />
                      </div>
                      {filteredBaselines.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No baselines match this filter.</p>
                      ) : (
                        <div className="space-y-2" role="radiogroup" aria-label="Baseline runs">
                          {filteredBaselines.map((run) => {
                            const title = taskTitleForRun(agent, run);
                            const task = taskForRun(agent, run);
                            const open = detailRunId === run.run_id;
                            const selected = parentRunId === run.run_id;
                            return (
                              <div
                                key={run.run_id}
                                className={cn(
                                  "rounded-xl border transition-colors",
                                  selected ? "border-foreground bg-muted/20" : "border-border/40",
                                )}
                              >
                                <label className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-muted/20">
                                  <input
                                    type="radio"
                                    name="baseline-parent"
                                    checked={selected}
                                    onChange={() => selectBaseline(run.run_id)}
                                    className="accent-primary shrink-0 mt-1"
                                  />
                                  <div className="min-w-0 flex-1 space-y-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-sm font-medium truncate">{title}</span>
                                      <span className="font-mono text-[11px] text-muted-foreground">{run.task_id}</span>
                                      <span className={cn(
                                        "text-[11px] font-mono",
                                        run.status === "passed" && "text-green-600",
                                        (run.status === "failed" || run.status === "error") && "text-red-500",
                                      )}>
                                        {run.status}
                                      </span>
                                      <span className="text-[11px] font-mono text-muted-foreground/70">
                                        {formatRunDuration(run.duration_ms)}
                                      </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground line-clamp-2">
                                      {task?.prompt ?? "No prompt on agent for this task id."}
                                    </p>
                                    <p className="font-mono text-[10px] text-muted-foreground/50 truncate" title={run.run_id}>
                                      {run.run_id}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    className="text-[11px] text-muted-foreground hover:text-foreground shrink-0 mt-0.5"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      setDetailRunId((prev) => (prev === run.run_id ? null : run.run_id));
                                      if (parentRunId !== run.run_id) selectBaseline(run.run_id);
                                    }}
                                  >
                                    {open ? "Hide" : "Detail"}
                                  </button>
                                </label>
                                {open && (
                                  <div className="px-4 pb-3 pt-0 border-t border-border/20 space-y-2">
                                    <p className="text-xs font-medium pt-2">Task prompt</p>
                                    <pre className="text-xs whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-muted-foreground">
                                      {task?.prompt ?? "—"}
                                    </pre>
                                    {run.error_message && (
                                      <p className="text-xs text-destructive">{run.error_message}</p>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {selectedBaseline && selectedLaunchTask && (
                  <PromptLaunchEditor
                    prefillKey={`${phase}:${parentRunId}`}
                    taskPrompt={selectedLaunchTask.prompt}
                    helperText={PROMPT_LAUNCH_COPY.helperInjected}
                    history={promptHistory}
                    disabled={launching}
                    onDraftChange={(draft, touched) => {
                      setPromptDraft(draft);
                      setPromptTouched(touched);
                    }}
                  />
                )}
              </>
            )}

            {phase === "after_fix" && (
              <div>
                <p className="text-sm font-medium mb-3">Fix kinds</p>
                <div className="flex flex-wrap gap-2">
                  {FIX_KINDS.map((kind) => {
                    const active = fixKinds.includes(kind);
                    return (
                      <button
                        key={kind}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setFixKinds((prev) => toggleLaunchFixKind(prev, kind))}
                        className={cn(
                          "px-2.5 py-1 rounded-full text-xs font-mono border transition-colors",
                          active
                            ? "border-foreground bg-foreground text-background"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {kind}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-3 px-8 py-4 border-t border-border/40">
          {launching && (
            <span role="status" className="text-xs text-muted-foreground flex-1">
              Launching run…
            </span>
          )}
          {error && <span className="text-xs text-destructive flex-1">{error}</span>}
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" onClick={onClose} disabled={launching}>Cancel</Button>
            <Button onClick={handleLaunch} disabled={launching || !launchReady} aria-busy={launching}>
              {launching ? "Launching…" : "Launch run"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function JuryLaunchFields({
  agent,
  launching,
  loadingRuns,
  runsError,
  juryLoading,
  juryLoadError,
  filter,
  onFilter,
  references,
  totalReferences,
  selectedRunId,
  selectedRun,
  detailRunId,
  onSelectRun,
  onToggleDetail,
  note,
  onNote,
  maxChars,
  permissions,
  choices,
  onTogglePermission,
  includeBaseline,
  onIncludeBaseline,
  mode,
  fixKinds,
  onToggleFixKind,
  promptTask,
  promptHistory,
  onDraftChange,
}: {
  agent: Agent | null;
  launching: boolean;
  loadingRuns: boolean;
  runsError: string | null;
  juryLoading: boolean;
  juryLoadError: string | null;
  filter: string;
  onFilter: (value: string) => void;
  references: Run[];
  totalReferences: number;
  selectedRunId: string | null;
  selectedRun: Run | null;
  detailRunId: string | null;
  onSelectRun: (runId: string) => void;
  onToggleDetail: (runId: string) => void;
  note: string;
  onNote: (value: string) => void;
  maxChars: number;
  permissions: string[];
  choices: string[];
  onTogglePermission: (permission: string) => void;
  includeBaseline: boolean;
  onIncludeBaseline: (value: boolean) => void;
  mode: "attack" | "replay" | null;
  fixKinds: FixKind[];
  onToggleFixKind: (kind: FixKind) => void;
  promptTask: AgentTask | undefined;
  promptHistory: PromptHistoryEntry[];
  onDraftChange: (draft: string, touched: boolean) => void;
}) {
  const noteLen = note.trim().length;
  return (
    <div className="space-y-6" aria-busy={launching || juryLoading || loadingRuns}>
      {juryLoading && <p className="text-xs text-muted-foreground">{JURY_LAUNCH_COPY.loadingCase}</p>}
      {juryLoadError && <p className="text-xs text-destructive">{juryLoadError}</p>}

      <div>
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-sm font-medium">{JURY_LAUNCH_COPY.referenceLabel}</p>
          <span className="text-xs text-muted-foreground">{references.length}/{totalReferences}</span>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          {mode === "replay" ? JURY_LAUNCH_COPY.replayHint : JURY_LAUNCH_COPY.attackHint}
        </p>
        {loadingRuns ? (
          <p className="text-xs text-muted-foreground">Loading runs…</p>
        ) : runsError ? (
          <p className="text-xs text-destructive">{runsError}</p>
        ) : totalReferences === 0 ? (
          <p className="text-xs text-muted-foreground">{JURY_LAUNCH_COPY.emptyReferences}</p>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
              <Input
                value={filter}
                onChange={(event) => onFilter(event.target.value)}
                placeholder="Filter by title, task, status, prompt…"
                className="pl-9 h-9 text-sm"
                aria-label="Filter reference runs"
                disabled={launching}
              />
            </div>
            {references.length === 0 ? (
              <p className="text-xs text-muted-foreground">No runs match this filter.</p>
            ) : (
              <div className="space-y-2" role="radiogroup" aria-label="Reference runs">
                {references.map((run) => {
                  const title = taskTitleForRun(agent, run);
                  const task = taskForRun(agent, run);
                  const open = detailRunId === run.run_id;
                  const selected = selectedRunId === run.run_id;
                  return (
                    <div
                      key={run.run_id}
                      className={cn(
                        "rounded-xl border transition-colors",
                        selected ? "border-foreground bg-muted/20" : "border-border/40",
                      )}
                    >
                      <label className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-muted/20">
                        <input
                          type="radio"
                          name="jury-reference"
                          checked={selected}
                          disabled={launching}
                          onChange={() => onSelectRun(run.run_id)}
                          className="accent-primary shrink-0 mt-1"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium truncate">{title}</span>
                            <span className="font-mono text-[11px] text-muted-foreground">{run.task_id}</span>
                            <span className="text-[11px] text-muted-foreground">{runPhaseLabel(run.phase)}</span>
                            <span className={cn(
                              "text-[11px] font-mono",
                              run.status === "passed" && "text-green-600",
                              (run.status === "failed" || run.status === "error") && "text-red-500",
                            )}>
                              {run.status}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {task?.prompt ?? "No prompt on agent for this task id."}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={launching}
                          className="text-[11px] text-muted-foreground hover:text-foreground shrink-0 mt-0.5 disabled:opacity-50"
                          onClick={(event) => {
                            event.preventDefault();
                            onToggleDetail(run.run_id);
                          }}
                        >
                          {open ? "Hide" : "Detail"}
                        </button>
                      </label>
                      {open && (
                        <div className="px-4 pb-3 pt-0 border-t border-border/20 space-y-2">
                          <p className="text-xs font-medium pt-2">Task prompt</p>
                          <pre className="text-xs whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-muted-foreground">
                            {task?.prompt ?? "—"}
                          </pre>
                          {run.error_message && (
                            <p className="text-xs text-destructive">{run.error_message}</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {selectedRun && (
        <PromptLaunchEditor
          prefillKey={`jury:${selectedRun.run_id}`}
          taskPrompt={promptTask?.prompt ?? ""}
          helperText={PROMPT_LAUNCH_COPY.helperJury}
          history={promptHistory}
          disabled={launching}
          onDraftChange={onDraftChange}
        />
      )}

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="jury-note" className="text-sm font-medium">{JURY_LAUNCH_COPY.noteLabel}</label>
          <span className={cn("text-xs font-mono text-muted-foreground", noteLen > maxChars && "text-red-500")}>
            {noteLen}/{maxChars}
          </span>
        </div>
        <textarea
          id="jury-note"
          value={note}
          disabled={launching}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onChange={(event) => onNote(event.target.value)}
          rows={7}
          className="w-full rounded-xl border border-border/40 bg-background px-3 py-2 text-sm leading-relaxed resize-y min-h-[8rem] disabled:opacity-50"
        />
        <p className="text-xs text-muted-foreground">
          Untrusted text appended to the task prompt. A permission named in the note is not a grant.
        </p>
      </div>

      <fieldset className="space-y-2" disabled={launching}>
        <legend className="text-sm font-medium">{JURY_LAUNCH_COPY.permissionsLabel}</legend>
        <div className="flex flex-wrap gap-2">
          {choices.map((permission) => {
            const active = permissions.includes(permission);
            return (
              <button
                key={permission}
                type="button"
                aria-pressed={active}
                disabled={launching}
                onClick={() => onTogglePermission(permission)}
                className={cn(
                  "px-2.5 py-1 rounded-full text-xs font-mono border transition-colors disabled:opacity-50",
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
        <p className="text-xs text-muted-foreground">
          Session grant sent with the case. Empty is a grant of nothing. Unknown names are rejected by the harness.
        </p>
      </fieldset>

      {mode !== "replay" && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={includeBaseline}
            disabled={launching}
            onChange={(event) => onIncludeBaseline(event.target.checked)}
          />
          <span>
            {JURY_LAUNCH_COPY.includeBaselineLabel}
            <span className="block text-xs text-muted-foreground">Default on for a first attack. Off when replaying.</span>
          </span>
        </label>
      )}

      {mode === "replay" && (
        <div>
          <p className="text-sm font-medium mb-3">Fix kinds</p>
          <p className="text-xs text-muted-foreground mb-2">{JURY_LAUNCH_COPY.replayHint}</p>
          <div className="flex flex-wrap gap-2">
            {FIX_KINDS.map((kind) => {
              const active = fixKinds.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={active}
                  disabled={launching}
                  onClick={() => onToggleFixKind(kind)}
                  className={cn(
                    "px-2.5 py-1 rounded-full text-xs font-mono border transition-colors disabled:opacity-50",
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {kind}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selectedRun && (
        <p className="text-xs font-mono text-muted-foreground">
          task {selectedRun.task_id} · {selectedRun.phase} · {mode ?? "pick a run"}
        </p>
      )}
    </div>
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
