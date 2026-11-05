/**
 * Bookmarkable trace analysis paths for #153. List and timeline stay in
 * traces.ts / TracePage; this file only names the entry points and copy.
 */

import type { Diagnosis, Trace } from "@mesa/shared";

export const TRACE_LIST_ROUTE = "/traces";
export const TRACE_DETAIL_ROUTE = "/traces/:traceId";
export const ANALYSIS_SECTION_ID = "analysis";

/** Empty-list copy from #153. Demo seed is inserted on lab boot, not from this UI. */
export const TRACE_EMPTY_SEED = "Seed demo traces";
export const TRACE_EMPTY_PULL = "Pull telemetry";

export type TracesIndexEmptyKind = "none" | "filtered" | "error";

export function tracesIndexEmptyCopy(kind: TracesIndexEmptyKind): string {
  if (kind === "error") return "The list could not be loaded.";
  if (kind === "filtered") return "No traces match these filters.";
  return `No traces yet. ${TRACE_EMPTY_SEED}, or ${TRACE_EMPTY_PULL}.`;
}

export function traceDetailHref(traceId: string | null | undefined, analysis = false): string | null {
  const id = traceId?.trim();
  if (!id) return null;
  const href = `/traces/${encodeURIComponent(id)}`;
  return analysis ? `${href}#${ANALYSIS_SECTION_ID}` : href;
}

export function parentRunHref(runId: string | null | undefined): string | null {
  const id = runId?.trim();
  return id ? `/runs/${encodeURIComponent(id)}` : null;
}

export function diagnosePath(traceId: string): string {
  return `/traces/${encodeURIComponent(traceId)}/diagnose`;
}

export function analysisView(diagnosis: Diagnosis | null | undefined): {
  present: boolean;
  summary: string | null;
  proposed_fixes: Diagnosis["proposed_fixes"];
  runDiagnosisCta: boolean;
} {
  if (!diagnosis) {
    return { present: false, summary: null, proposed_fixes: [], runDiagnosisCta: true };
  }
  return {
    present: true,
    summary: diagnosis.cause,
    proposed_fixes: [...diagnosis.proposed_fixes],
    runDiagnosisCta: false,
  };
}

export function parseDiagnoseTrace(body: unknown): { ok: true; trace: Trace } | { ok: false; message: string } {
  if (!isRecord(body) || typeof body.trace_id !== "string" || body.trace_id.trim() === "") {
    return { ok: false, message: "The diagnose response did not include a trace." };
  }
  if (!("diagnosis" in body)) {
    return { ok: false, message: "The diagnose response did not include diagnosis." };
  }
  return { ok: true, trace: body as unknown as Trace };
}

const DIAGNOSE_HINTS: Record<string, string> = {
  diagnosis_busy: "Another diagnosis is already running for this trace. Retry shortly.",
  trace_changed: "The stored trace changed during diagnosis. Reload the page and try again.",
  diagnosis_not_configured: "Diagnosis is not configured on the lab.",
  diagnosis_unavailable: "The diagnosis service is unavailable. Retry shortly.",
  diagnosis_timeout: "Diagnosis timed out. Retry.",
  diagnosis_upstream_error: "The diagnosis service failed. Retry.",
  diagnosis_store_error: "The lab could not save the diagnosis. Retry.",
  invalid_diagnosis_response: "The diagnosis service returned an invalid document.",
  not_found: "Trace not found.",
  invalid_request: "Send no body or an empty JSON object.",
};

export function describeDiagnoseFailure(error: unknown): string {
  const http = readHttpError(error);
  if (http) {
    const hint = http.code && DIAGNOSE_HINTS[http.code] ? ` ${DIAGNOSE_HINTS[http.code]}` : "";
    const details = http.code ? `HTTP ${http.status} ${http.code}` : `HTTP ${http.status}`;
    return `${http.message}${hint} ${details}`.trim();
  }
  if (error instanceof TypeError || (error instanceof Error && /fetch|network/i.test(error.message))) {
    return "The browser could not reach the lab. Check that the backend is running, then retry.";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Diagnosis failed.";
}

function readHttpError(error: unknown): { status: number; message: string; code: string | null } | null {
  if (typeof error !== "object" || error === null || !("status" in error) || typeof error.status !== "number") return null;
  const message = "message" in error && typeof error.message === "string" && error.message.trim() ? error.message : "The request failed.";
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  return { status: error.status, message, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
