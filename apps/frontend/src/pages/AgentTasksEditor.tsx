import { useState, type ReactNode } from "react";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import {
  CHECK_REGISTRY,
  TASK_EVALSET_VERSION,
  isCheckType,
  type Agent,
  type AgentTask,
  type AgentTaskCheck,
  type CheckParamField,
  type CheckType,
  type LibrarySeedLoan,
} from "@mesa/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { generateEvalset } from "@/lib/api";
import { applyProposedEvalset, buildEvalsetGenerateBody, evalsetAiErrorText } from "@/lib/evalset";
import {
  checksForDomain,
  defaultCheckForDomain,
  deriveTaskDomain,
  domainSetupCopy,
  permissionsForDomain,
  type TaskDomain,
} from "@/lib/task-domain";
import { appendEvalCase, evalsetErrorMessage, evalsetIssues, removeEvalCase, writeEvalCase } from "@/lib/tasks";

export function blankTasks(domain: TaskDomain = "shop"): AgentTask[] {
  return [blankTask(domain === "library" ? "renew-loan" : "search", domain)];
}

export function validateTasks(tasks: AgentTask[]): string | undefined {
  if (tasks.length === 0) return "Add at least one task.";
  const seen = new Set<string>();
  for (const task of tasks) {
    const label = task.task_id.trim() || "A task";
    if (!task.task_id.trim()) return "Every task needs an id.";
    if (seen.has(task.task_id)) return `Duplicate task id ${task.task_id}.`;
    seen.add(task.task_id);
    if (!task.title.trim()) return `${label} needs a title.`;
    if (!task.prompt.trim()) return `${label} needs a prompt.`;
    for (const line of task.setup.cart) {
      if (!line.sku.trim()) return `${label} has a cart line without a SKU.`;
      if (!Number.isInteger(line.qty) || line.qty < 1) {
        return `${label} cart quantity must be an integer of at least 1.`;
      }
    }
    for (const loan of task.setup.library?.loans ?? []) {
      if (!loan.loan_id.trim()) return `${label} has a library loan without a loan id.`;
      if (!loan.book_id.trim()) return `${label} has a library loan without a book id.`;
      if (!loan.patron_id.trim()) return `${label} has a library loan without a patron id.`;
      if (!Number.isInteger(loan.renewals) || loan.renewals < 0) {
        return `${label} library loan renewals must be an integer of at least 0.`;
      }
    }
    if (task.success_test.checks.length === 0) return `${label} needs a check.`;
    for (const check of task.success_test.checks) {
      if (!isCheckType(check.name)) return `${label} has an unknown check.`;
      if (!check.description.trim()) return `${label} check ${check.name} needs a description.`;
      const issue = paramIssue(label, check);
      if (issue) return issue;
    }
    const evalsetError = evalsetErrorMessage(task);
    if (evalsetError) return `${label} evalset: ${evalsetError}`;
  }
  return undefined;
}

export function AgentTasksEditor({
  tasks,
  docs,
  showErrors = false,
  onChange,
}: {
  tasks: AgentTask[];
  docs?: Agent["docs"];
  showErrors?: boolean;
  onChange: (tasks: AgentTask[]) => void;
}) {
  const [instructions, setInstructions] = useState<Record<number, string>>({});
  const [aiBusy, setAiBusy] = useState<Record<number, boolean>>({});
  const [aiError, setAiError] = useState<Record<number, string>>({});
  const [aiToast, setAiToast] = useState<Record<number, string>>({});
  const domain = deriveTaskDomain(tasks);
  const copy = domainSetupCopy(domain);
  // Full lists so create can leave shop blanks and still add library loans/checks.
  const permissionOptions = permissionsForDomain("mixed");
  const checkOptions = checksForDomain("mixed");
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

  async function runEvalsetAi(index: number, mode: "generate" | "revise") {
    const task = tasks[index];
    if (!task) return;
    setAiBusy((current) => ({ ...current, [index]: true }));
    setAiError((current) => ({ ...current, [index]: "" }));
    setAiToast((current) => ({ ...current, [index]: "" }));
    try {
      const result = await generateEvalset(
        buildEvalsetGenerateBody(task, { mode, instruction: instructions[index], docs }),
      );
      patch(index, (next) => applyProposedEvalset(next, result.evalset));
      setAiToast((current) => ({
        ...current,
        [index]: "Proposed evalset loaded into this form. Review the cases. Nothing is saved until you save the Agent.",
      }));
    } catch (error) {
      const shown = evalsetAiErrorText(error);
      setAiError((current) => ({
        ...current,
        [index]: shown.details ? `${shown.message} (${shown.details})` : shown.message,
      }));
    } finally {
      setAiBusy((current) => ({ ...current, [index]: false }));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Tasks ({tasks.length})</p>
          <p className="text-xs text-muted-foreground/80 mt-1">{copy.intro}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => onChange([...tasks, blankTask(nextTaskId(tasks, domain), domain)])}
        >
          <Plus className="h-3.5 w-3.5" />
          Add task
        </Button>
      </div>

      {tasks.map((task, index) => {
        const issues = evalsetIssues(task);
        const evalCases = task.evalset?.cases ?? [];
        return (
        <div key={`${task.task_id}-${index}`} className="rounded-xl bg-muted/40 px-4 py-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs font-mono text-muted-foreground">{task.task_id || "task"}</p>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Remove task"
              disabled={tasks.length === 1}
              onClick={() => onChange(tasks.filter((_, taskIndex) => taskIndex !== index))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Task id">
              <Input
                value={task.task_id}
                onChange={(event) => patch(index, (next) => { next.task_id = event.target.value; })}
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Title">
              <Input
                value={task.title}
                onChange={(event) => patch(index, (next) => { next.title = event.target.value; })}
              />
            </Field>
          </div>

          <Field label="Prompt">
            <textarea
              value={task.prompt}
              onChange={(event) => patch(index, (next) => { next.prompt = event.target.value; })}
              rows={3}
              className="w-full rounded-none border-0 border-b border-border/60 bg-transparent px-0 py-1 text-sm placeholder:text-muted-foreground/50 focus-visible:border-foreground focus-visible:outline-none resize-none"
            />
          </Field>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Granted permissions</p>
            <div className="flex flex-wrap gap-2">
              {permissionOptions.map((permission) => {
                const active = task.setup.permissions.includes(permission);
                return (
                  <button
                    key={permission}
                    type="button"
                    onClick={() =>
                      patch(index, (next) => {
                        next.setup.permissions = togglePermission(next.setup.permissions, permission, domain);
                      })
                    }
                    className={
                      active
                        ? "px-2.5 py-1 rounded-full text-xs font-mono border border-foreground bg-foreground text-background"
                        : "px-2.5 py-1 rounded-full text-xs font-mono border border-border text-muted-foreground"
                    }
                  >
                    {permission}
                  </button>
                );
              })}
            </div>
          </div>

          {copy.setupShop ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Cart seeded before the run</p>
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
                <p className="text-xs text-muted-foreground/70">No cart lines.</p>
              ) : (
                task.setup.cart.map((line, lineIndex) => (
                  <div key={lineIndex} className="flex items-center gap-2">
                    <Input
                      value={line.sku}
                      placeholder="SKU"
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
                      title="Remove line"
                      onClick={() => patch(index, (next) => { next.setup.cart = next.setup.cart.filter((_, i) => i !== lineIndex); })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={task.setup.orders.some((order) => order.from_cart)}
                  onChange={(event) =>
                    patch(index, (next) => {
                      next.setup.orders = event.target.checked ? [{ from_cart: true }] : [];
                    })
                  }
                />
                Check out that cart into an order before the agent runs
              </label>
            </div>
          ) : null}

          {copy.setupLibrary ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Library loans seeded before the run</p>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    patch(index, (next) => {
                      const loans = next.setup.library?.loans ?? [];
                      next.setup.library = { loans: [...loans, blankLoan()] };
                    })
                  }
                >
                  Add loan
                </Button>
              </div>
              {(task.setup.library?.loans.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground/70">No library loans.</p>
              ) : (
                (task.setup.library?.loans ?? []).map((loan, loanIndex) => (
                  <div key={loanIndex} className="grid gap-2 sm:grid-cols-2 rounded-lg bg-background/70 px-3 py-3">
                    <Input
                      value={loan.loan_id}
                      placeholder="loan_id"
                      className="font-mono text-xs"
                      onChange={(event) =>
                        patch(index, (next) => {
                          const current = next.setup.library?.loans[loanIndex];
                          if (current) current.loan_id = event.target.value;
                        })
                      }
                    />
                    <Input
                      value={loan.book_id}
                      placeholder="book_id"
                      className="font-mono text-xs"
                      onChange={(event) =>
                        patch(index, (next) => {
                          const current = next.setup.library?.loans[loanIndex];
                          if (current) current.book_id = event.target.value;
                        })
                      }
                    />
                    <Input
                      value={loan.patron_id}
                      placeholder="patron_id"
                      className="font-mono text-xs"
                      onChange={(event) =>
                        patch(index, (next) => {
                          const current = next.setup.library?.loans[loanIndex];
                          if (current) current.patron_id = event.target.value;
                        })
                      }
                    />
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        value={loan.renewals}
                        className="w-24 font-mono text-xs"
                        onChange={(event) =>
                          patch(index, (next) => {
                            const current = next.setup.library?.loans[loanIndex];
                            const renewals = Number(event.target.value);
                            if (current && Number.isInteger(renewals)) current.renewals = renewals;
                          })
                        }
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        title="Remove loan"
                        onClick={() =>
                          patch(index, (next) => {
                            const loans = (next.setup.library?.loans ?? []).filter((_, i) => i !== loanIndex);
                            if (loans.length === 0) delete next.setup.library;
                            else next.setup.library = { loans };
                          })
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Checks</p>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() =>
                  patch(index, (next) => {
                    next.success_test.checks = [
                      ...next.success_test.checks,
                      checkOf(defaultCheckForDomain(domain)),
                    ];
                  })
                }
              >
                Add check
              </Button>
            </div>
            {task.success_test.checks.map((check, checkIndex) => {
              const fallback = defaultCheckForDomain(domain);
              const checkName = isCheckType(check.name) ? check.name : fallback;
              const optionNames = checkOptions.includes(checkName)
                ? checkOptions
                : ([checkName, ...checkOptions] as CheckType[]);
              const spec = CHECK_REGISTRY[checkName];
              return (
                <div key={checkIndex} className="rounded-lg bg-background/70 px-3 py-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={checkName}
                      onChange={(event) => {
                        const name = event.target.value;
                        if (!isCheckType(name)) return;
                        patch(index, (next) => {
                          next.success_test.checks[checkIndex] = checkOf(name);
                        });
                      }}
                      className="flex-1 bg-transparent text-xs font-mono border-b border-border/60 py-1 outline-none"
                    >
                      {optionNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      title="Remove check"
                      disabled={task.success_test.checks.length === 1}
                      onClick={() =>
                        patch(index, (next) => {
                          next.success_test.checks = next.success_test.checks.filter((_, i) => i !== checkIndex);
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{spec.summary}</p>
                  <Input
                    value={check.description}
                    placeholder="What this check means"
                    onChange={(event) =>
                      patch(index, (next) => {
                        const current = next.success_test.checks[checkIndex];
                        if (current) current.description = event.target.value;
                      })
                    }
                  />
                  {spec.params.map((field) => (
                    <Field key={field.name} label={`${field.name}${field.required ? "" : " (optional)"}`}>
                      <Input
                        value={paramValue(check, field)}
                        className="font-mono text-xs"
                        onChange={(event) =>
                          patch(index, (next) => {
                            const current = next.success_test.checks[checkIndex];
                            if (!current) return;
                            current.params = setParam(current.params, field, event.target.value);
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
              );
            })}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">Evalset</p>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => patch(index, (next) => appendEvalCase(next))}
              >
                Add case
              </Button>
            </div>
            <p className="text-xs text-muted-foreground/80">
              Helps Grok judge this task&apos;s Trace or Run. It does not replace the verifier. Pass and fail still come from the checks above. AI assist proposes cases only; it does not judge a Trace or Run here.
            </p>
            <Field label="Instruction for AI (optional)">
              <textarea
                value={instructions[index] ?? ""}
                rows={2}
                placeholder="Optional. Example: cover the product-page claim and keep case ids stable."
                className="w-full rounded-none border-0 border-b border-border/60 bg-transparent px-0 py-1 text-sm placeholder:text-muted-foreground/50 focus-visible:border-foreground focus-visible:outline-none resize-none"
                onChange={(event) =>
                  setInstructions((current) => ({ ...current, [index]: event.target.value }))
                }
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="gap-1.5"
                disabled={Boolean(aiBusy[index])}
                onClick={() => void runEvalsetAi(index, "generate")}
              >
                <Sparkles className="h-3 w-3" />
                {aiBusy[index] ? "Working…" : "Genera evalset"}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="gap-1.5"
                disabled={Boolean(aiBusy[index]) || evalCases.length === 0}
                onClick={() => void runEvalsetAi(index, "revise")}
              >
                <Sparkles className="h-3 w-3" />
                Modifica con AI
              </Button>
            </div>
            {aiToast[index] ? <p className="text-xs text-foreground">{aiToast[index]}</p> : null}
            {aiError[index] ? <p className="text-xs text-destructive">{aiError[index]}</p> : null}
            {task.evalset ? (
              <p className={task.evalset.version === TASK_EVALSET_VERSION ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
                Version {task.evalset.version}
              </p>
            ) : null}
            {showErrors && issues.evalset ? <p className="text-xs text-destructive">{issues.evalset}</p> : null}
            {evalCases.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                {task.evalset
                  ? "No cases yet. Version 1 with an empty list is valid."
                  : "No cases. Add a case to store an evalset. Removing the last case omits the field, so the next update drops it."}
              </p>
            ) : (
              evalCases.map((entry, caseIndex) => {
                const caseError = issues.cases[caseIndex];
                return (
                  <div key={caseIndex} className="space-y-2 rounded-lg bg-background/70 px-3 py-3">
                    <div className="flex items-end gap-2">
                      <div className="min-w-0 flex-1">
                        <Field label="Case id">
                          <Input
                            value={entry.case_id}
                            aria-invalid={showErrors && Boolean(caseError?.case_id)}
                            className="font-mono text-xs"
                            onChange={(event) =>
                              patch(index, (next) => writeEvalCase(next, caseIndex, { case_id: event.target.value }))
                            }
                          />
                        </Field>
                        {showErrors && caseError?.case_id ? (
                          <p className="text-xs text-destructive">{caseError.case_id}</p>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove evalset case ${entry.case_id || caseIndex + 1}`}
                        onClick={() => patch(index, (next) => removeEvalCase(next, caseIndex))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <Field label="Expectation">
                      <textarea
                        value={entry.expectation}
                        rows={2}
                        aria-invalid={showErrors && Boolean(caseError?.expectation)}
                        placeholder="What should Grok look for in the Trace or Run?"
                        className="w-full rounded-none border-0 border-b border-border/60 bg-transparent px-0 py-1 text-sm placeholder:text-muted-foreground/50 focus-visible:border-foreground focus-visible:outline-none resize-none"
                        onChange={(event) =>
                          patch(index, (next) => writeEvalCase(next, caseIndex, { expectation: event.target.value }))
                        }
                      />
                    </Field>
                    {showErrors && caseError?.expectation ? (
                      <p className="text-xs text-destructive">{caseError.expectation}</p>
                    ) : null}
                    <Field label="Rubric (optional)">
                      <textarea
                        value={entry.rubric ?? ""}
                        rows={2}
                        aria-invalid={showErrors && Boolean(caseError?.rubric)}
                        placeholder="Optional. Leave blank to omit. This does not change the verifier."
                        className="w-full rounded-none border-0 border-b border-border/60 bg-transparent px-0 py-1 text-sm placeholder:text-muted-foreground/50 focus-visible:border-foreground focus-visible:outline-none resize-none"
                        onChange={(event) =>
                          patch(index, (next) => writeEvalCase(next, caseIndex, { rubric: event.target.value }))
                        }
                      />
                    </Field>
                    {showErrors && caseError?.rubric ? (
                      <p className="text-xs text-destructive">{caseError.rubric}</p>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function blankTask(taskId: string, domain: TaskDomain = "shop"): AgentTask {
  if (domain === "library") {
    return {
      task_id: taskId,
      title: "Renew a loan",
      prompt: "Renew the seeded loan for the patron.",
      setup: {
        cart: [],
        orders: [],
        permissions: ["read", "write:loan"],
        library: { loans: [blankLoan()] },
      },
      success_test: {
        type: "verifier_checks",
        checks: [checkOf("loan_renewed")],
      },
    };
  }
  return {
    task_id: taskId,
    title: "Search and open a product",
    prompt: "Search the catalog and open the matching product page.",
    setup: { cart: [], orders: [], permissions: ["read"] },
    success_test: {
      type: "verifier_checks",
      checks: [
        { name: "catalog_read", description: "The session recorded a catalog search." },
        checkOf("product_viewed"),
      ],
    },
  };
}

function blankLoan(): LibrarySeedLoan {
  return { loan_id: "loan-1042", book_id: "BK-OWL", patron_id: "patron-ada", renewals: 0 };
}

function checkOf(name: CheckType): AgentTaskCheck {
  const spec = CHECK_REGISTRY[name];
  const params: Record<string, unknown> = {};
  for (const field of spec.params) {
    if (!field.required) continue;
    if (field.type === "integer") {
      params[field.name] = 1;
      continue;
    }
    if (name === "product_viewed" && field.name === "product_id") params[field.name] = "SKU-MUG-01";
    else if (name === "loan_renewed" && field.name === "loan_id") params[field.name] = "loan-1042";
    else if (name === "loan_returned" && field.name === "loan_id") params[field.name] = "loan-1042";
    else if (name === "hold_placed" && field.name === "book_id") params[field.name] = "BK-OWL";
    else if (name === "hold_placed" && field.name === "patron_id") params[field.name] = "patron-ada";
    else params[field.name] = "";
  }
  const check: AgentTaskCheck = {
    name,
    description: spec.summary,
  };
  if (Object.keys(params).length > 0) check.params = params;
  return check;
}

function nextTaskId(tasks: AgentTask[], domain: TaskDomain): string {
  const used = new Set(tasks.map((task) => task.task_id));
  const prefix = domain === "library" ? "loan-task" : "task";
  let index = tasks.length + 1;
  let id = `${prefix}-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${prefix}-${index}`;
  }
  return id;
}

function togglePermission(current: string[], permission: string, domain: TaskDomain): string[] {
  const next = new Set(current);
  if (next.has(permission)) next.delete(permission);
  else next.add(permission);
  return permissionsForDomain(domain).filter((entry) => next.has(entry));
}

function paramIssue(label: string, check: AgentTaskCheck): string | undefined {
  if (!isCheckType(check.name)) return `${label} has an unknown check.`;
  const params = check.params ?? {};
  for (const field of CHECK_REGISTRY[check.name].params) {
    const value = params[field.name];
    if (value === undefined) {
      if (field.required) return `${label} check ${check.name} needs ${field.name}.`;
      continue;
    }
    if (field.type === "string" && (typeof value !== "string" || value.trim().length === 0)) {
      return `${label} check ${check.name} ${field.name} must be a non-empty string.`;
    }
    if (field.type === "integer" && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
      return `${label} check ${check.name} ${field.name} must be an integer of at least 1.`;
    }
  }
  return undefined;
}

function paramValue(check: AgentTaskCheck, field: CheckParamField): string | number {
  const value = check.params?.[field.name];
  if (typeof value === "string" || typeof value === "number") return value;
  return "";
}

function setParam(
  params: Record<string, unknown> | undefined,
  field: CheckParamField,
  raw: string,
): Record<string, unknown> | undefined {
  const next = { ...(params ?? {}) };
  if (field.type === "integer") {
    if (raw.trim() === "") delete next[field.name];
    else {
      const qty = Number(raw);
      if (Number.isInteger(qty)) next[field.name] = qty;
    }
  } else if (raw.trim() === "") {
    delete next[field.name];
  } else {
    next[field.name] = raw;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
