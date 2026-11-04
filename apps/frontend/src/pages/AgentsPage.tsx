import type { ReactNode } from "react";
import { useState } from "react";
import { Pencil, PlusCircle, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { deleteAgent, listAgents, saveAgent, updateAgent, type AgentDraft } from "@/lib/api";
import type { Agent, AgentInstanceKind } from "@mesa/shared";

interface FormState {
  name: string;
  description: string;
  instance_base_url: string;
  test_instance_base_url: string;
  instance_kind: AgentInstanceKind;
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
};

function agentToForm(agent: Agent): FormState {
  return {
    name: agent.name,
    description: agent.description,
    instance_base_url: agent.instance.base_url,
    test_instance_base_url: agent.test_instance.base_url,
    instance_kind: agent.instance.kind,
  };
}

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>(() => listAgents());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setSheetOpen(true);
  }

  function openEdit(agent: Agent) {
    setEditing(agent);
    setForm(agentToForm(agent));
    setErrors({});
    setSheetOpen(true);
  }

  function handleDelete(agent: Agent) {
    if (!window.confirm(`Delete "${agent.name}"?`)) return;
    deleteAgent(agent.agent_id);
    setAgents(listAgents());
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
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSave() {
    if (!validate()) return;
    const draft: AgentDraft = {
      name: form.name.trim(),
      description: form.description.trim(),
      instance_base_url: form.instance_base_url.trim(),
      test_instance_base_url: form.test_instance_base_url.trim(),
      instance_kind: form.instance_kind,
      tasks: editing?.tasks,
    };
    try {
      if (editing) {
        updateAgent(editing.agent_id, draft);
      } else {
        saveAgent(draft);
      }
      setAgents(listAgents());
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

      <div className="grid gap-3 sm:grid-cols-2">
        {agents.map((agent) => (
          <AgentCard
            key={agent.agent_id}
            agent={agent}
            onEdit={() => openEdit(agent)}
            onDelete={() => handleDelete(agent)}
          />
        ))}
      </div>

      <Sheet open={sheetOpen} onOpenChange={(open: boolean) => setSheetOpen(open)}>
        <SheetContent side="right" className="flex flex-col overflow-hidden">
          <SheetHeader>
            <SheetTitle>{editing ? "Edit agent" : "New agent"}</SheetTitle>
            <SheetDescription>
              {editing
                ? `Editing · ${editing.agent_id}`
                : "Register a new agent to run tasks against."}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-5">
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
                placeholder="Short description of what this agent does"
                rows={3}
                className="w-full rounded-2xl border border-transparent bg-input/50 px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 resize-none transition-[color,box-shadow,background-color]"
              />
            </FormField>

            <FormField label="Kind">
              <div className="flex gap-5">
                {(["external", "reference"] as AgentInstanceKind[]).map((k) => {
                  const locked = editing?.instance.kind === "reference" && k !== "reference";
                  return (
                    <label
                      key={k}
                      className={cn(
                        "flex items-center gap-2 text-sm cursor-pointer",
                        locked && "opacity-40 pointer-events-none"
                      )}
                    >
                      <input
                        type="radio"
                        name="instance_kind"
                        value={k}
                        checked={form.instance_kind === k}
                        onChange={() => setField("instance_kind", k)}
                        disabled={locked}
                        className="accent-primary"
                      />
                      {k}
                    </label>
                  );
                })}
              </div>
            </FormField>

            <FormField label="Instance base URL" error={errors.instance_base_url} required>
              <Input
                value={form.instance_base_url}
                onChange={(e) => setField("instance_base_url", e.target.value)}
                placeholder="http://127.0.0.1:3002"
                className="font-mono text-xs"
                aria-invalid={!!errors.instance_base_url}
              />
            </FormField>

            <FormField label="Test instance base URL">
              <Input
                value={form.test_instance_base_url}
                onChange={(e) => setField("test_instance_base_url", e.target.value)}
                placeholder={form.instance_base_url || "http://127.0.0.1:3002"}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground mt-1">Defaults to instance URL if empty.</p>
            </FormField>

            {editing && editing.tasks.length > 0 && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  Tasks ({editing.tasks.length})
                </p>
                <div className="space-y-2">
                  {editing.tasks.map((task) => (
                    <div key={task.task_id} className="rounded-xl bg-muted/40 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{task.title}</span>
                        <span className="text-xs font-mono text-muted-foreground shrink-0">{task.task_id}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{task.prompt}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {task.success_test.checks.length} check
                        {task.success_test.checks.length !== 1 ? "s" : ""}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!editing && (
              <p className="text-xs text-muted-foreground italic">Tasks can be added after saving.</p>
            )}
          </div>

          <SheetFooter className="border-t border-border/50">
            {errors.save && (
              <div className="w-full rounded-lg bg-destructive/10 text-destructive text-xs px-3 py-2 mb-1">
                {errors.save}
              </div>
            )}
            <div className="flex gap-2 w-full">
              <Button variant="outline" className="flex-1" onClick={() => setSheetOpen(false)}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={handleSave}>
                Save
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function AgentCard({
  agent,
  onEdit,
  onDelete,
}: {
  agent: Agent;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isReference = agent.instance.kind === "reference";
  return (
    <div className="rounded-2xl bg-card shadow-island p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{agent.name}</span>
            {isReference ? (
              <Badge variant="secondary" className="text-xs">reference</Badge>
            ) : (
              <Badge variant="outline" className="text-xs">external</Badge>
            )}
          </div>
          <p className="text-xs font-mono text-muted-foreground mt-0.5 truncate">{agent.agent_id}</p>
        </div>
        <div className="flex gap-1 shrink-0">
          <Button size="icon-sm" variant="ghost" onClick={onEdit} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {!isReference && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onDelete}
              title="Delete"
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {agent.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">{agent.description}</p>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground border-t border-border/40 pt-3 mt-auto">
        <span className="font-mono truncate max-w-[70%]">{agent.instance.base_url}</span>
        <span>
          {agent.tasks.length} task{agent.tasks.length !== 1 ? "s" : ""}
        </span>
      </div>
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
