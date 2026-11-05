import type { RunPhase } from "@mesa/shared";

/** Session grants `POST /attacker/jury-case` accepts when the describe text cannot be parsed. */
export const JURY_PERMISSIONS = ["read", "write:cart", "write:order", "write:order:cancel"] as const;

export const JURY_NOTE_MAX = 8000;

export const JURY_SESSION_KEY = "mesa.jury.session";

export const WORLD_BUSY_CODE = "world_busy";

/** Existing trace page. `frontend.open_trace.ui_route` uses the same pattern. */
export const DEFAULT_TRACE_UI_ROUTE = "/traces/:traceId";

export interface JuryFormValues {
  note: string;
  taskId: string;
  permissions: string[];
  includeBaseline: boolean;
}

/**
 * Screen split from `GET /attacker/jury-case` on the structured-contract branch.
 * Absent on current main. The form still works from `structured` and the case fields.
 */
export interface JuryFrontendContract {
  issue?: number;
  trace_page_issue?: number;
  default_task_id?: string;
  note_widens_permissions?: boolean;
  diagnosis_on_launch?: null;
  payload_id?: string;
  open_trace?: {
    response_field?: string;
    api?: string;
    ui_route?: string;
  };
  verdict_field?: string;
  baseline_sources?: readonly string[];
  replay?: {
    phase?: string;
    parent_field?: string;
    fix_kinds?: readonly string[];
  };
  http_409?: {
    jury_and_runs?: string;
    diagnose?: readonly string[];
  };
}

export interface JuryCaseDescription {
  case_id?: string;
  task_id?: string;
  note?: { body?: string; title?: string; payload_id?: string };
  granted_permissions?: string[];
  frontend?: JuryFrontendContract;
  structured?: {
    method?: string;
    path?: string;
    fields?: {
      note?: string;
      task_id?: string;
      permissions?: string;
      include_baseline?: string;
      fix_kinds?: string;
      parent_run_id?: string;
      prompt_override?: string;
    };
  };
}

export interface JuryFormHints {
  note: string;
  task: string;
  permissions: string;
  includeBaseline: string;
}

export interface JuryVerifierView {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
}

export interface JuryBaselineComparison {
  source: "live" | "last" | "frozen" | "none";
  task_id: string;
  baseline_verifier_passed: boolean | null;
  attacked_verifier_passed: boolean;
  same_verdict: boolean | null;
  baseline_order_status: string | null;
  attacked_order_status: string;
  baseline_trace_id: string | null;
  attacked_trace_id: string;
  fixture?: { run: string; trace: string };
}

export interface JuryAttacker {
  used: boolean;
  payload_id: string | null;
}

export interface JuryCaseReport {
  task_id: string;
  granted_permissions?: string[];
  wire_permissions?: string[];
  client_called?: boolean;
  outcome: {
    verifier: JuryVerifierView;
    success: boolean;
    /** Always null on this POST. A diagnosis is a later `POST /traces/:traceId/diagnose`. */
    diagnosis?: null;
  };
  baseline_comparison: JuryBaselineComparison;
  links: {
    attacked_trace: string;
    attacked_run: string;
    baseline_trace: string | null;
    baseline_run: string | null;
  };
  attacked: {
    run: { run_id: string; phase: RunPhase | string; task_id?: string };
    trace: { trace_id: string; fault: { attacker: JuryAttacker } };
  };
}

export interface JuryRequestBody {
  /** Optional. Backend defaults to the process fixture agent id when omitted. */
  agent_id?: string;
  note: string;
  task_id: string;
  permissions: string[];
  include_baseline: boolean;
  fix_kinds?: string[];
  parent_run_id?: string;
  /** Same as POST /runs. Omitted when the launch uses the reference task prompt. */
  prompt_override?: string;
}

export interface JuryTaskChoice {
  id: string;
  title: string;
}

export interface JurySession {
  form: JuryFormValues;
  submitted: JuryFormValues | null;
  launch: JuryCaseReport | null;
  replay: JuryCaseReport | null;
}

interface AgentTasks {
  agent_id: string;
  tasks: { task_id: string; title: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names listed after `Allowed:` in `structured.fields.permissions`. */
export function parseAllowedPermissions(text: string | undefined): string[] {
  if (!text) return [];
  const match = text.match(/Allowed:\s*([^.]+)/i);
  if (!match?.[1]) return [];
  return match[1].split(",").map((name) => name.trim()).filter((name) => name.length > 0);
}

/** Task id named as `Default T5` in `structured.fields.task_id`. */
export function taskIdFromStructured(text: string | undefined): string | null {
  if (!text) return null;
  const match = text.match(/Default\s+([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

export function defaultIncludeBaseline(text: string | undefined): boolean {
  if (!text) return true;
  return !/Default\s+false/i.test(text);
}

export function defaultTaskId(
  description: Pick<JuryCaseDescription, "task_id" | "structured" | "frontend">,
): string {
  const fromFrontend = description.frontend?.default_task_id?.trim();
  if (fromFrontend) return fromFrontend;
  const concrete = description.task_id?.trim();
  if (concrete) return concrete;
  return taskIdFromStructured(description.structured?.fields?.task_id) ?? "T5";
}

export function noteMaxChars(description: Pick<JuryCaseDescription, "structured"> | null | undefined): number {
  const match = description?.structured?.fields?.note?.match(/(\d{2,})\s*characters/i);
  if (!match?.[1]) return JURY_NOTE_MAX;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : JURY_NOTE_MAX;
}

const HINTS_WITHOUT_CONTRACT: JuryFormHints = {
  note: "Untrusted text appended to the prompt. A permission named in the note is not a grant.",
  task: "Default T5. The task must exist on the reference agent.",
  permissions: "Session grant sent by the control. A name that appears only in the note is not added.",
  includeBaseline: "Default yes. Same task and permissions, without the note and without the attacker.",
};

/** Hints from `frontend` / `structured`. English fallback when those fields are absent. */
export function formHints(description: JuryCaseDescription | null | undefined): JuryFormHints {
  if (!description) return HINTS_WITHOUT_CONTRACT;
  const fields = description.structured?.fields;
  const taskDefault = defaultTaskId(description);
  const noteDoesNotGrant = description.frontend?.note_widens_permissions !== true;
  return {
    note: fields?.note?.trim() || HINTS_WITHOUT_CONTRACT.note,
    task: fields?.task_id?.trim() || `Default ${taskDefault}. The task must exist on the reference agent.`,
    permissions: fields?.permissions?.trim()
      || (noteDoesNotGrant
        ? HINTS_WITHOUT_CONTRACT.permissions
        : "Session grant sent by the permission control."),
    includeBaseline: fields?.include_baseline?.trim() || HINTS_WITHOUT_CONTRACT.includeBaseline,
  };
}

export function permissionChoices(
  description: Pick<JuryCaseDescription, "granted_permissions" | "structured">,
): string[] {
  const parsed = parseAllowedPermissions(description.structured?.fields?.permissions);
  const base = parsed.length > 0 ? parsed : [...JURY_PERMISSIONS];
  const extras = (description.granted_permissions ?? []).filter((name) => !base.includes(name));
  return [...base, ...extras];
}

export function formDefaults(description: JuryCaseDescription): JuryFormValues {
  const choices = permissionChoices(description);
  const granted = description.granted_permissions ?? [];
  const selected = granted.length > 0 ? granted : ["read"];
  return {
    note: description.note?.body ?? "",
    taskId: defaultTaskId(description),
    permissions: orderedPermissions(selected.length > 0 ? selected : ["read"], choices),
    includeBaseline: defaultIncludeBaseline(description.structured?.fields?.include_baseline),
  };
}

export function orderedPermissions(selected: readonly string[], choices: readonly string[]): string[] {
  const chosen = new Set(selected);
  const known = choices.filter((name) => chosen.has(name));
  const extra = selected.filter((name) => !choices.includes(name));
  return [...known, ...extra];
}

export function tasksForJury(agents: readonly AgentTasks[], defaultTaskIdValue: string): JuryTaskChoice[] {
  const reference = agents.find((agent) => agent.agent_id === "reference-shop")
    ?? agents.find((agent) => agent.tasks.some((task) => task.task_id === defaultTaskIdValue));
  const tasks = (reference?.tasks ?? []).map((task) => ({ id: task.task_id, title: task.title || task.task_id }));
  if (defaultTaskIdValue && !tasks.some((task) => task.id === defaultTaskIdValue)) {
    tasks.unshift({ id: defaultTaskIdValue, title: defaultTaskIdValue });
  }
  if (tasks.length === 0) {
    const id = defaultTaskIdValue || "T5";
    return [{ id, title: id }];
  }
  return tasks;
}

export function validateJuryForm(form: JuryFormValues, maxChars: number = JURY_NOTE_MAX): string | null {
  const note = form.note.trim();
  if (note.length === 0) return "The attack note cannot be empty.";
  if (note.length > maxChars) return `The note can be at most ${maxChars} characters.`;
  if (form.taskId.trim().length === 0) return "Choose a task.";
  return null;
}

/**
 * Permissions are the control selection only.
 * A token in the note, including `write:order:cancel`, is not copied onto the body.
 */
export function permissionsFromControl(selected: readonly string[], choices?: readonly string[]): string[] {
  return choices ? orderedPermissions(selected, choices) : [...selected];
}

export function juryLaunchBody(input: JuryFormValues, choices?: readonly string[]): JuryRequestBody {
  return {
    note: input.note.trim(),
    task_id: input.taskId.trim(),
    permissions: permissionsFromControl(input.permissions, choices),
    include_baseline: input.includeBaseline,
  };
}

export function replayFixKinds(
  description: Pick<JuryCaseDescription, "frontend"> | null | undefined,
): string[] {
  const kinds = description?.frontend?.replay?.fix_kinds
    ?.map((kind) => kind.trim())
    .filter((kind) => kind.length > 0);
  if (kinds && kinds.length > 0) return kinds;
  return ["permission_guard"];
}

/** Replay of the injected run. The note and grant are sent again; they are not stored on the Run. */
export function juryReplayBody(
  input: JuryFormValues,
  parentRunId: string,
  choices?: readonly string[],
  fixKinds: readonly string[] = ["permission_guard"],
): JuryRequestBody {
  return {
    ...juryLaunchBody({ ...input, includeBaseline: false }, choices),
    fix_kinds: [...fixKinds],
    parent_run_id: parentRunId,
  };
}

export function injectedParentRunId(report: JuryCaseReport | null): string | null {
  const run = report?.attacked?.run;
  if (!run || run.phase !== "injected") return null;
  const id = run.run_id?.trim();
  return id ? id : null;
}

export function traceUiRoute(
  description: Pick<JuryCaseDescription, "frontend"> | null | undefined,
): string {
  const route = description?.frontend?.open_trace?.ui_route?.trim();
  if (route && route.startsWith("/") && (route.includes(":traceId") || route.includes(":id"))) return route;
  return DEFAULT_TRACE_UI_ROUTE;
}

/**
 * Map `links.attacked_trace` (`GET /traces/:id`) onto the trace page.
 * `uiRoute` comes from `frontend.open_trace.ui_route` when that block exists.
 */
export function traceHref(link: string | null | undefined, uiRoute: string = DEFAULT_TRACE_UI_ROUTE): string | null {
  if (!link) return null;
  const match = link.match(/\/traces\/([^/?#\s]+)/);
  const raw = match?.[1];
  if (!raw) return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // Keep the path segment as sent.
  }
  const encoded = encodeURIComponent(id);
  if (uiRoute.includes(":traceId")) return uiRoute.replaceAll(":traceId", encoded);
  if (uiRoute.includes(":id")) return uiRoute.replaceAll(":id", encoded);
  return `/traces/${encoded}`;
}

/**
 * A frozen baseline leaves `links.baseline_trace` null.
 * The fixture id is not a stored trace: opening it is a 404.
 */
export function openableBaselineHref(
  source: string,
  baselineLink: string | null | undefined,
  uiRoute: string = DEFAULT_TRACE_UI_ROUTE,
): string | null {
  if (source === "frozen" || source === "none") return null;
  return traceHref(baselineLink, uiRoute);
}

export function runHref(link: string | null | undefined): string | null {
  if (!link) return null;
  const match = link.match(/\/runs\/([^/?#\s]+)/);
  const id = match?.[1];
  if (!id) return null;
  try {
    return `/runs/${encodeURIComponent(decodeURIComponent(id))}`;
  } catch {
    return `/runs/${encodeURIComponent(id)}`;
  }
}

export function baselineSourceLabel(source: JuryBaselineComparison["source"]): string {
  switch (source) {
    case "live":
      return "live — baseline from this request";
    case "last":
      return "last — last saved baseline for this task";
    case "frozen":
      return "frozen — T5 fixture, no baseline in memory";
    case "none":
      return "none — no baseline to compare";
    default:
      return source;
  }
}

export function sameVerdictLabel(value: boolean | null): string {
  if (value === null) return "—";
  return value ? "yes" : "no";
}

export function isWorldBusy(error: unknown, describedCode?: string | null): boolean {
  if (!isRecord(error) || error.status !== 409 || typeof error.code !== "string") return false;
  if (error.code === WORLD_BUSY_CODE) return true;
  return typeof describedCode === "string" && describedCode.length > 0 && error.code === describedCode;
}

function isVerifier(value: unknown): value is JuryVerifierView {
  if (!isRecord(value) || typeof value.passed !== "boolean" || !Array.isArray(value.checks)) return false;
  return value.checks.every(
    (check) => isRecord(check) && typeof check.name === "string" && typeof check.passed === "boolean",
  );
}

export function isJuryReport(value: unknown): value is JuryCaseReport {
  if (!isRecord(value)) return false;
  if (!isRecord(value.outcome) || !isVerifier(value.outcome.verifier)) return false;
  if (!isRecord(value.baseline_comparison) || typeof value.baseline_comparison.source !== "string") return false;
  if (!isRecord(value.links) || typeof value.links.attacked_trace !== "string") return false;
  if (!isRecord(value.attacked) || !isRecord(value.attacked.run) || typeof value.attacked.run.run_id !== "string") {
    return false;
  }
  if (!isRecord(value.attacked.trace) || !isRecord(value.attacked.trace.fault)) return false;
  const attacker = value.attacked.trace.fault.attacker;
  if (!isRecord(attacker) || typeof attacker.used !== "boolean") return false;
  return true;
}

function isForm(value: unknown): value is JuryFormValues {
  if (!isRecord(value)) return false;
  return typeof value.note === "string"
    && typeof value.taskId === "string"
    && Array.isArray(value.permissions)
    && value.permissions.every((entry) => typeof entry === "string")
    && typeof value.includeBaseline === "boolean";
}

export function parseJurySession(raw: string | null): JurySession | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isForm(value.form)) return null;
    const submitted = value.submitted === null || value.submitted === undefined
      ? null
      : isForm(value.submitted) ? value.submitted : null;
    const launch = value.launch === null || value.launch === undefined
      ? null
      : isJuryReport(value.launch) ? value.launch : null;
    const replay = value.replay === null || value.replay === undefined
      ? null
      : isJuryReport(value.replay) ? value.replay : null;
    if (value.submitted !== null && value.submitted !== undefined && submitted === null) return null;
    if (value.launch !== null && value.launch !== undefined && launch === null) return null;
    if (value.replay !== null && value.replay !== undefined && replay === null) return null;
    return { form: value.form, submitted, launch, replay };
  } catch {
    return null;
  }
}
