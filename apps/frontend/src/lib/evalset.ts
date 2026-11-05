import { TASK_EVALSET_VERSION, type Agent, type AgentTask, type TaskEvalset } from "@mesa/shared";

export type EvalsetGenerateMode = "generate" | "revise";

export interface EvalsetGenerateBody {
  mode: EvalsetGenerateMode;
  task: AgentTask;
  instruction?: string;
  docs?: Agent["docs"];
}

export interface EvalsetAiError {
  message: string;
  details?: string;
}

/** Same shape `ApiError` in `api.ts` exposes. This file does not import the client. */
interface HttpErrorLike {
  status?: number;
  code?: string | null;
  message: string;
}

export function buildEvalsetGenerateBody(
  task: AgentTask,
  options: {
    mode: EvalsetGenerateMode;
    instruction?: string;
    docs?: Agent["docs"];
  },
): EvalsetGenerateBody {
  const payloadTask = structuredClone(task);
  if (options.mode === "generate") delete payloadTask.evalset;
  const body: EvalsetGenerateBody = { mode: options.mode, task: payloadTask };
  const instruction = options.instruction?.trim();
  if (instruction) body.instruction = instruction;
  if (options.docs) body.docs = options.docs;
  return body;
}

/** Copy a proposed evalset onto the in-memory task. The Agent is not saved here. */
export function applyProposedEvalset(task: AgentTask, evalset: TaskEvalset): void {
  task.evalset = {
    version: TASK_EVALSET_VERSION,
    cases: evalset.cases.map((entry) => {
      const next = { case_id: entry.case_id, expectation: entry.expectation };
      return entry.rubric ? { ...next, rubric: entry.rubric } : next;
    }),
  };
}

export function isEvalsetProposal(value: unknown): value is { evalset: TaskEvalset } {
  if (typeof value !== "object" || value === null) return false;
  const evalset = (value as { evalset?: unknown }).evalset;
  if (typeof evalset !== "object" || evalset === null) return false;
  const record = evalset as { version?: unknown; cases?: unknown };
  return record.version === TASK_EVALSET_VERSION && Array.isArray(record.cases);
}

export function evalsetAiErrorText(error: unknown): EvalsetAiError {
  const http = asHttpError(error);
  if (http) {
    if (http.status === 503 || http.code === "evalset_not_configured" || http.code === "evalset_unavailable" || http.code === "grok_not_configured") {
      return {
        message: "AI assist is not configured. You can still edit cases and save the Agent.",
        details: statusLine(http),
      };
    }
    if (http.status === 504 || http.code === "evalset_timeout") {
      return {
        message: "The request timed out. The evalset in this form was not changed.",
        details: statusLine(http),
      };
    }
    if (http.code === "invalid_evalset" || http.code === "invalid_evalset_response") {
      return {
        message: http.message || "The model output was not a valid evalset.",
        details: statusLine(http),
      };
    }
    if (http.code === "invalid_task" || http.status === 400) {
      return {
        message: http.message || "This task is not valid enough to generate an evalset yet.",
        details: statusLine(http),
      };
    }
    return {
      message: http.message || "AI assist failed. You can still edit cases and save the Agent.",
      details: statusLine(http),
    };
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return { message: error.message };
  }
  return { message: "AI assist failed. You can still edit cases and save the Agent." };
}

function statusLine(error: HttpErrorLike): string | undefined {
  if (typeof error.status !== "number") return error.code ?? undefined;
  return error.code ? `HTTP ${error.status} ${error.code}` : `HTTP ${error.status}`;
}

function asHttpError(error: unknown): HttpErrorLike | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof record.message !== "string") return null;
  if (record.status !== undefined && typeof record.status !== "number") return null;
  if (record.code !== undefined && record.code !== null && typeof record.code !== "string") return null;
  return {
    status: typeof record.status === "number" ? record.status : undefined,
    code: typeof record.code === "string" ? record.code : null,
    message: record.message,
  };
}
