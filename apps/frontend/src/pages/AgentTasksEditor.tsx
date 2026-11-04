import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { CHECK_REGISTRY, CHECK_TYPES, TASK_PERMISSIONS, isCheckType, type AgentTask } from "@mesa/shared";
import { CodeTip } from "@/components/CodeTip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { checkLabel, paramLabel, permissionLabel } from "@/lib/labels";
import { blankTask, checkOf, nextTaskId, type TaskFieldError } from "@/lib/tasks";

export function AgentTasksEditor({
  tasks,
  onChange,
  errors,
  showErrors,
}: {
  tasks: AgentTask[];
  onChange: (tasks: AgentTask[]) => void;
  errors?: TaskFieldError[];
  showErrors?: boolean;
}) {
  function patch(index: number, recipe: (task: AgentTask) => void) {
    onChange(
      tasks.map((task, taskIndex) => {
        if (taskIndex !== index) return task;
        const next = structuredClone(task);
        recipe(next);
        return next;
      }),
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Tasks</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Setup runs before the agent. Checks are scored from the shop afterward.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5 rounded-full"
          onClick={() => onChange([...tasks, blankTask(nextTaskId(tasks))])}
        >
          <Plus className="size-3.5" />
          Add task
        </Button>
      </div>

      {tasks.map((task, index) => {
        const field = errors?.[index];
        const show = Boolean(showErrors);
        return (
          <div key={`${task.task_id}-${index}`} className="space-y-4 rounded-xl bg-muted/40 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium">{task.title.trim() || "New task"}</p>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${task.title.trim() || "task"}`}
                disabled={tasks.length === 1}
                onClick={() => onChange(tasks.filter((_, taskIndex) => taskIndex !== index))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Task id" error={show ? field?.task_id : undefined}>
                <Input
                  value={task.task_id}
                  aria-invalid={show && Boolean(field?.task_id)}
                  onChange={(event) => patch(index, (next) => { next.task_id = event.target.value; })}
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="Title" error={show ? field?.title : undefined}>
                <Input
                  value={task.title}
                  aria-invalid={show && Boolean(field?.title)}
                  onChange={(event) => patch(index, (next) => { next.title = event.target.value; })}
                />
              </Field>
            </div>

            <Field label="Prompt" error={show ? field?.prompt : undefined}>
              <Textarea
                value={task.prompt}
                rows={3}
                aria-invalid={show && Boolean(field?.prompt)}
                placeholder="What should the agent do?"
                onChange={(event) => patch(index, (next) => { next.prompt = event.target.value; })}
              />
            </Field>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Permissions</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {TASK_PERMISSIONS.map((permission) => {
                  const checked = task.setup.permissions.includes(permission);
                  const id = `task-${index}-perm-${permission}`;
                  return (
                    <label key={permission} htmlFor={id} className="flex items-start gap-2 text-sm">
                      <Checkbox
                        id={id}
                        className="mt-0.5"
                        checked={checked}
                        onCheckedChange={(next) =>
                          patch(index, (taskNext) => {
                            taskNext.setup.permissions = next
                              ? TASK_PERMISSIONS.filter((entry) => entry === permission || taskNext.setup.permissions.includes(entry))
                              : taskNext.setup.permissions.filter((entry) => entry !== permission);
                          })
                        }
                      />
                      <CodeTip label={permissionLabel(permission)} code={permission} />
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Cart seeded before the run</p>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => patch(index, (next) => { next.setup.cart = [...next.setup.cart, { sku: "", qty: 1 }]; })}
                >
                  Add line
                </Button>
              </div>
              {task.setup.cart.length === 0 ? (
                <p className="text-sm text-muted-foreground">No cart lines.</p>
              ) : (
                task.setup.cart.map((line, lineIndex) => {
                  const lineError = field?.cart[lineIndex];
                  return (
                    <div key={lineIndex} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Input
                          value={line.sku}
                          placeholder="SKU"
                          aria-invalid={show && Boolean(lineError?.sku)}
                          className="font-mono text-xs"
                          onChange={(event) =>
                            patch(index, (next) => {
                              const cartLine = next.setup.cart[lineIndex];
                              if (cartLine) cartLine.sku = event.target.value;
                            })
                          }
                        />
                        <Input
                          type="number"
                          min={1}
                          value={line.qty}
                          aria-label="Quantity"
                          aria-invalid={show && Boolean(lineError?.qty)}
                          className="w-20 font-mono text-xs"
                          onChange={(event) =>
                            patch(index, (next) => {
                              const cartLine = next.setup.cart[lineIndex];
                              const qty = Number(event.target.value);
                              if (cartLine && Number.isInteger(qty)) cartLine.qty = qty;
                            })
                          }
                        />
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Remove cart line"
                          onClick={() => patch(index, (next) => { next.setup.cart = next.setup.cart.filter((_, i) => i !== lineIndex); })}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                      {show && lineError?.sku && <p className="text-xs text-destructive">{lineError.sku}</p>}
                      {show && lineError?.qty && <p className="text-xs text-destructive">{lineError.qty}</p>}
                    </div>
                  );
                })
              )}
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={task.setup.orders.some((order) => order.from_cart)}
                  onCheckedChange={(checked) =>
                    patch(index, (next) => {
                      next.setup.orders = checked ? [{ from_cart: true }] : [];
                    })
                  }
                />
                Check out that cart into an order before the agent runs
              </label>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Checks</p>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    patch(index, (next) => {
                      next.success_test.checks = [...next.success_test.checks, checkOf("catalog_read")];
                    })
                  }
                >
                  Add check
                </Button>
              </div>
              {task.success_test.checks.map((check, checkIndex) => {
                const checkName = isCheckType(check.name) ? check.name : "catalog_read";
                const spec = CHECK_REGISTRY[checkName];
                const checkError = field?.checks[checkIndex];
                return (
                  <div key={checkIndex} className="space-y-2 rounded-lg bg-background/70 px-3 py-3">
                    <div className="flex items-center gap-2">
                      <Select
                        value={checkName}
                        onValueChange={(value) => {
                          if (!value || !isCheckType(value)) return;
                          patch(index, (next) => {
                            next.success_test.checks[checkIndex] = checkOf(value);
                          });
                        }}
                      >
                        <SelectTrigger aria-label="Check">
                          <SelectValue>{(value: string | null) => (value ? checkLabel(value) : "Choose a check")}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {CHECK_TYPES.map((name) => (
                            <SelectItem key={name} value={name}>
                              {checkLabel(name)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Remove check"
                        disabled={task.success_test.checks.length === 1}
                        onClick={() =>
                          patch(index, (next) => {
                            next.success_test.checks = next.success_test.checks.filter((_, i) => i !== checkIndex);
                          })
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <CodeTip label={spec.summary} code={checkName}>
                      <span className="text-sm text-muted-foreground">{spec.summary}</span>
                    </CodeTip>
                    <Field label="What this check means" error={show ? checkError?.description : undefined}>
                      <Input
                        value={check.description}
                        aria-invalid={show && Boolean(checkError?.description)}
                        onChange={(event) =>
                          patch(index, (next) => {
                            const current = next.success_test.checks[checkIndex];
                            if (current) current.description = event.target.value;
                          })
                        }
                      />
                    </Field>
                    {spec.params.map((param) => (
                      <Field
                        key={param.name}
                        label={param.required ? paramLabel(param.name) : `${paramLabel(param.name)} (optional)`}
                        error={show ? checkError?.params[param.name] : undefined}
                        hint={param.description}
                      >
                        <Input
                          value={paramValue(check, param.name)}
                          aria-invalid={show && Boolean(checkError?.params[param.name])}
                          className="font-mono text-xs"
                          onChange={(event) =>
                            patch(index, (next) => {
                              const current = next.success_test.checks[checkIndex];
                              if (!current) return;
                              current.params = setParam(current.params, param.type, param.name, event.target.value);
                            })
                          }
                        />
                      </Field>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function paramValue(check: AgentTask["success_test"]["checks"][number], name: string): string | number {
  const value = check.params?.[name];
  if (typeof value === "string" || typeof value === "number") return value;
  return "";
}

function setParam(
  params: Record<string, unknown> | undefined,
  type: "string" | "integer",
  name: string,
  raw: string,
): Record<string, unknown> | undefined {
  const next = { ...(params ?? {}) };
  if (type === "integer") {
    if (raw.trim() === "") delete next[name];
    else {
      const qty = Number(raw);
      if (Number.isInteger(qty)) next[name] = qty;
    }
  } else if (raw.trim() === "") {
    delete next[name];
  } else {
    next[name] = raw;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
