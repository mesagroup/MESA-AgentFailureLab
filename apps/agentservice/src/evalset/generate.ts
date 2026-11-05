import { TASK_EVALSET_VERSION, type Agent, type AgentTask, type TaskEvalCase, type TaskEvalset } from "@mesa/shared";
import { validateAgentTask, validateTaskEvalset } from "@mesa/shared/validate";
import type { DiagnosisModel, ModelCompletion, ModelUsage } from "../diagnosis/diagnose.js";
import { RetryableModelError } from "../grok/client.js";

export const EVALSET_MAX_INSTRUCTION_CHARS = 4_000;
export const EVALSET_MAX_CASES = 12;

export type EvalsetGenerateMode = "generate" | "revise";

export interface EvalsetGenerateRequest {
  task: AgentTask;
  docs?: Agent["docs"];
  instruction?: string;
  mode: EvalsetGenerateMode;
}

export interface EvalsetGenerateResult {
  evalset: TaskEvalset;
}

export class EvalsetGenerateError extends Error {
  readonly name = "EvalsetGenerateError";

  constructor(
    readonly code: "invalid_evalset" | "evalset_timeout" | "evalset_generation_failed",
    readonly errors: string[] = [],
  ) {
    super(code);
  }
}

export interface GenerateEvalsetOptions {
  model: DiagnosisModel;
  modelName: string;
  timeoutMs: number;
  onUsage?: (usage: ModelUsage) => void;
}

export async function generateEvalset(
  request: EvalsetGenerateRequest,
  options: GenerateEvalsetOptions,
): Promise<EvalsetGenerateResult> {
  const prompt = renderEvalsetPrompt(request);
  let completion: ModelCompletion;
  try {
    completion = await withTimeout(
      options.model.complete({
        model: options.modelName,
        system: prompt.system,
        user: prompt.user,
      }),
      options.timeoutMs,
    );
  } catch (error) {
    if (error instanceof EvalsetGenerateError) throw error;
    if (isTimeoutError(error)) {
      throw new EvalsetGenerateError("evalset_timeout");
    }
    throw new EvalsetGenerateError("evalset_generation_failed");
  }
  if (completion.usage !== null) {
    options.onUsage?.(completion.usage);
  }
  const parsed = parseJsonObject(completion.content);
  if (parsed === null) {
    throw new EvalsetGenerateError("invalid_evalset", ["Model output was not a JSON object."]);
  }
  const normalized = normalizeProposedEvalset(parsed);
  const validated = validateTaskEvalset(normalized);
  if (!validated.ok) {
    throw new EvalsetGenerateError("invalid_evalset", validated.errors);
  }
  if (validated.value.cases.length > EVALSET_MAX_CASES) {
    throw new EvalsetGenerateError("invalid_evalset", [
      `Evalset may have at most ${EVALSET_MAX_CASES} cases.`,
    ]);
  }
  return { evalset: validated.value };
}

export function stubEvalset(request: EvalsetGenerateRequest): EvalsetGenerateResult {
  const existing = request.mode === "revise" ? request.task.evalset : undefined;
  if (existing && existing.cases.length > 0) {
    const note = request.instruction?.trim();
    const cases = existing.cases.map((entry, index) => {
      if (index !== 0 || !note) return entry;
      const extra = ` Operator note: ${clip(note, 240)}`;
      return {
        ...entry,
        expectation: `${entry.expectation}${entry.expectation.endsWith(".") ? "" : "."}${extra}`,
      };
    });
    const validated = validateTaskEvalset({ version: TASK_EVALSET_VERSION, cases });
    if (!validated.ok) {
      throw new EvalsetGenerateError("invalid_evalset", validated.errors);
    }
    return { evalset: validated.value };
  }
  const cases: TaskEvalCase[] = [
    {
      case_id: slug(`${request.task.task_id}-claim`),
      expectation: `The assistant's claims match the task prompt (${clip(request.task.prompt, 180)}) and cite the steps that produced them.`,
      rubric: "Cite the claim step and any tool steps. Do not score mock world state; that is outcome.verifier.",
    },
  ];
  const check = request.task.success_test.checks[0];
  if (check) {
    cases.push({
      case_id: slug(`${request.task.task_id}-tools`),
      expectation: `The trace shows tool use that matches the intent of check ${check.name}, without treating that check as the verdict.`,
    });
  }
  const validated = validateTaskEvalset({ version: TASK_EVALSET_VERSION, cases });
  if (!validated.ok) {
    throw new EvalsetGenerateError("invalid_evalset", validated.errors);
  }
  return { evalset: validated.value };
}

export function parseEvalsetGenerateRequest(
  body: unknown,
): { ok: true; value: EvalsetGenerateRequest } | { ok: false; error: "invalid_request" | "invalid_task"; message?: string; errors?: string[] } {
  if (!isRecord(body)) {
    return { ok: false, error: "invalid_request", message: "Body must be a JSON object." };
  }
  const mode = body.mode === undefined ? inferMode(body) : body.mode;
  if (mode !== "generate" && mode !== "revise") {
    return { ok: false, error: "invalid_request", message: "mode must be generate or revise." };
  }
  let instruction: string | undefined;
  if (body.instruction !== undefined) {
    if (typeof body.instruction !== "string") {
      return { ok: false, error: "invalid_request", message: "instruction must be a string." };
    }
    const trimmed = body.instruction.trim();
    if (trimmed.length > EVALSET_MAX_INSTRUCTION_CHARS) {
      return {
        ok: false,
        error: "invalid_request",
        message: `instruction must be at most ${EVALSET_MAX_INSTRUCTION_CHARS} characters.`,
      };
    }
    if (trimmed.length > 0) instruction = trimmed;
  }
  let docs: Agent["docs"] | undefined;
  if (body.docs !== undefined) {
    if (!isRecord(body.docs)) {
      return { ok: false, error: "invalid_request", message: "docs must be an object." };
    }
    docs = body.docs as Agent["docs"];
  }
  const taskBody = isRecord(body.task) ? { ...body.task } : body.task;
  if (mode === "generate" && isRecord(taskBody)) delete taskBody.evalset;
  const parsedTask = validateAgentTask(taskBody);
  if (!parsedTask.ok) {
    return { ok: false, error: "invalid_task", errors: parsedTask.errors };
  }
  if (mode === "revise" && parsedTask.value.evalset === undefined) {
    return {
      ok: false,
      error: "invalid_request",
      message: "revise requires task.evalset. Use generate when the task has no evalset yet.",
    };
  }
  return { ok: true, value: { task: parsedTask.value, docs, instruction, mode } };
}

export function renderEvalsetPrompt(request: EvalsetGenerateRequest): { system: string; user: string } {
  const system = [
    "You propose a TaskEvalset for a lab task. The evalset is judge input a later Grok call may read when looking at a Trace or Run for this task.",
    "You are not judging a Trace or Run now. You do not replace the deterministic verifier. You do not write outcome.verifier, fault.labels, or diagnosis.",
    "Cases describe what a later judge should look for in claims, steps, and tool use. They are not world-state checks. Those stay on success_test.",
    `Return JSON only: version ${TASK_EVALSET_VERSION} and cases[]. Each case needs case_id (unique, non-empty) and expectation (non-empty). rubric is optional; use an empty string to omit it.`,
    `Propose 1 to ${EVALSET_MAX_CASES} cases. Do not invent verifier results.`,
  ].join(" ");
  const view = {
    mode: request.mode,
    instruction: request.instruction ?? null,
    task: {
      task_id: request.task.task_id,
      title: request.task.title,
      prompt: request.task.prompt,
      setup: request.task.setup,
      success_test: request.task.success_test,
      evalset: request.mode === "revise" ? request.task.evalset ?? null : null,
    },
    docs: request.docs ?? null,
  };
  const user =
    request.mode === "revise"
      ? `Revise this task's evalset. Keep useful cases, apply the operator instruction when present, and stay inside the schema.\n${JSON.stringify(view)}`
      : `Propose a new evalset for this task from its prompt, docs, tools, setup, and success_test.\n${JSON.stringify(view)}`;
  return { system, user };
}

export function normalizeProposedEvalset(value: Record<string, unknown>): unknown {
  const cases = Array.isArray(value.cases) ? value.cases : [];
  return {
    version: TASK_EVALSET_VERSION,
    cases: cases.filter(isRecord).map((entry) => {
      const next: TaskEvalCase = {
        case_id: typeof entry.case_id === "string" ? entry.case_id.trim() : "",
        expectation: typeof entry.expectation === "string" ? entry.expectation.trim() : "",
      };
      if (typeof entry.rubric === "string" && entry.rubric.trim().length > 0) {
        next.rubric = entry.rubric.trim();
      }
      return next;
    }),
  };
}

function inferMode(body: Record<string, unknown>): EvalsetGenerateMode {
  if (!isRecord(body.task)) return "generate";
  const evalset = body.task.evalset;
  if (evalset && isRecord(evalset) && Array.isArray(evalset.cases) && evalset.cases.length > 0) {
    return "revise";
  }
  return "generate";
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new EvalsetGenerateError("evalset_timeout"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof RetryableModelError) return true;
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function clip(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function slug(value: string): string {
  const next = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return next.length > 0 ? next : "case-1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}
