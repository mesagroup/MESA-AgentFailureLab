import type { TaskEvalset, Trace } from "@mesa/shared";
import { validateTaskEvalset, validateTrace, type ValidationResult } from "@mesa/shared/validate";

/**
 * Body of `POST /diagnose`.
 * A bare Trace is the original contract (no evalset).
 * `{ trace, evalset? }` is the additive envelope used when the backend resolved
 * a task evalset. The response is still a Trace; evalset is never persisted on it.
 */
export interface DiagnoseRequest {
  trace: Trace;
  evalset?: TaskEvalset;
}

export type DiagnoseRequestError = "invalid_trace" | "invalid_evalset" | "invalid_diagnose_request";

export type DiagnoseParseResult =
  | { ok: true; value: DiagnoseRequest }
  | { ok: false; error: DiagnoseRequestError; errors: string[] };

export function parseDiagnoseRequest(body: unknown): DiagnoseParseResult {
  if (!isRecord(body)) {
    return { ok: false, error: "invalid_trace", errors: ["/ body must be a JSON object"] };
  }
  if (Object.hasOwn(body, "trace")) {
    const extra = Object.keys(body).filter((key) => key !== "trace" && key !== "evalset");
    if (extra.length > 0) {
      return {
        ok: false,
        error: "invalid_diagnose_request",
        errors: extra.map((key) => `/${key} is not a diagnose request field`),
      };
    }
    const parsed = validateTrace(body.trace);
    if (!parsed.ok) return fail("invalid_trace", parsed);
    if (!Object.hasOwn(body, "evalset")) {
      return { ok: true, value: { trace: parsed.value } };
    }
    const evalset = validateTaskEvalset(body.evalset);
    if (!evalset.ok) return fail("invalid_evalset", evalset);
    return { ok: true, value: { trace: parsed.value, evalset: evalset.value } };
  }
  const parsed = validateTrace(body);
  if (!parsed.ok) return fail("invalid_trace", parsed);
  return { ok: true, value: { trace: parsed.value } };
}

function fail(
  error: DiagnoseRequestError,
  parsed: Extract<ValidationResult<unknown>, { ok: false }>,
): DiagnoseParseResult {
  return { ok: false, error, errors: parsed.errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
