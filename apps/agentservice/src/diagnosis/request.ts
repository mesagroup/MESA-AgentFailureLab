import type { TaskEvalset, Trace } from "@mesa/shared";
import { validateTaskEvalset, validateTrace } from "@mesa/shared/validate";

export type DiagnoseRequest =
  | { ok: true; trace: Trace; taskEvalset?: TaskEvalset }
  | { ok: false; error: "invalid_trace" | "invalid_task_evalset"; errors: string[] };

/**
 * `POST /diagnose` body.
 * A Trace is the no-evalset call. `{ trace, task_evalset }` is the guidance call.
 * Any other shape is an invalid trace. The response is still a Trace.
 */
export function parseDiagnoseRequest(body: unknown): DiagnoseRequest {
  if (isEvalsetEnvelope(body)) {
    const trace = validateTrace(body.trace);
    if (!trace.ok) return { ok: false, error: "invalid_trace", errors: trace.errors };
    const evalset = validateTaskEvalset(body.task_evalset);
    if (!evalset.ok) return { ok: false, error: "invalid_task_evalset", errors: evalset.errors };
    return { ok: true, trace: trace.value, taskEvalset: evalset.value };
  }
  const trace = validateTrace(body);
  if (!trace.ok) return { ok: false, error: "invalid_trace", errors: trace.errors };
  return { ok: true, trace: trace.value };
}

function isEvalsetEnvelope(body: unknown): body is { trace: unknown; task_evalset: unknown } {
  if (!isRecord(body)) return false;
  const keys = Object.keys(body);
  return keys.length === 2 && Object.hasOwn(body, "trace") && Object.hasOwn(body, "task_evalset");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
