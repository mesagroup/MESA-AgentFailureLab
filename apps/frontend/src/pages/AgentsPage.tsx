import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Pencil, PlusCircle, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { deleteAgent, listAgents, saveAgent, updateAgent, type AgentDraft } from "@/lib/api";
import type { Agent, AgentInstanceKind, AgentTask } from "@mesa/shared";
import { AgentTasksEditor, blankTasks, validateTasks } from "@/pages/AgentTasksEditor";

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
};

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
  const [agents, setAgents] = useState<Agent[]>([]);
  const [query, setQuery] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});

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
    setForm({ ...EMPTY_FORM, tasks: blankTasks() });
    setErrors({});
    setSheetOpen(true);
  }

  function openEdit(agent: Agent) {
    setEditing(agent);
    setForm(agentToForm(agent));
    setErrors({});
    setSheetOpen(true);
  }

  async function handleDelete(agent: Agent) {
    if (!window.confirm(`Delete "${agent.name}"?`)) return;
    await deleteAgent(agent.agent_id);
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
    setErrors(errs);
    return Object.keys(errs).length === 0;
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
        <Button onClick={openCreate} size="sm" variant="outline" className="gap-1.5 rounded-full">
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

      {/* Count — on canvas */}
      <div className="flex justify-end px-1">
        <span className="text-xs text-muted-foreground">
          {query
            ? `${filtered.length} of ${agents.length} agent${agents.length !== 1 ? "s" : ""}`
            : `${agents.length} agent${agents.length !== 1 ? "s" : ""}`}
        </span>
      </div>

      {/* List island */}
      <div className="rounded-2xl bg-card shadow-island overflow-hidden">

        {/* List */}
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
                  {/* Name + ID */}
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

                  {/* Instance URL */}
                  <span className="hidden sm:block font-mono text-xs text-muted-foreground/60 truncate max-w-[260px]">
                    {agent.instance.base_url}
                  </span>

                  {/* Task count */}
                  <span className="text-xs text-muted-foreground/60 shrink-0 w-14 text-right">
                    {agent.tasks.length} task{agent.tasks.length !== 1 ? "s" : ""}
                  </span>

                  {/* Actions */}
                  <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button size="icon-sm" variant="ghost" onClick={() => openEdit(agent)} title="Edit">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {!isReference && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => handleDelete(agent)}
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

      <Sheet open={sheetOpen} onOpenChange={(open: boolean) => setSheetOpen(open)}>
        <SheetContent side="bottom" className="flex flex-col h-[95vh] rounded-t-2xl p-0">

          {/* Header: data is the hero, action is the label */}
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

          {/* Body: identity (left) | config (right) */}
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
                    const isReference = editing?.instance.kind === "reference";
                    const active = form.instance_kind === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        disabled={isReference}
                        onClick={() => !isReference && setField("instance_kind", k)}
                        className={cn(
                          "px-3 py-1 rounded-full text-sm border transition-colors",
                          active
                            ? "bg-foreground text-background border-foreground"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40",
                          isReference && "opacity-50 cursor-not-allowed"
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

            {/* Right — technical config */}
            <div className="flex-1 overflow-y-auto px-8 py-6 space-y-7">

              {/* Endpoints */}
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

              <AgentTasksEditor
                tasks={form.tasks}
                onChange={(tasks) => {
                  setForm((current) => ({ ...current, tasks }));
                  setErrors((current) => ({ ...current, tasks: undefined }));
                }}
              />
              {errors.tasks && <p className="text-xs text-destructive">{errors.tasks}</p>}
            </div>
          </div>

          {/* Footer */}
          <div className="shrink-0 flex items-center gap-3 px-8 py-4 border-t border-border/40">
            {errors.save && (
              <span className="text-xs text-destructive flex-1">{errors.save}</span>
            )}
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={() => setSheetOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave}>
                {editing ? "Save changes" : "Register agent"}
              </Button>
            </div>
          </div>

        </SheetContent>
      </Sheet>
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
