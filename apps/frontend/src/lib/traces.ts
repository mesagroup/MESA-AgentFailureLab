/**
 * Traces list and `POST /agents/:agentId/traces/pull` (#154).
 * Field names match the lab response. A blank pull `since` is omitted so the
 * first pull fetches the full seed and a later pull uses `last_pull_at`.
 */

import { TRACE_SOURCES, type Trace, type TraceSource } from "@mesa/shared";

export { TRACE_SOURCES, type TraceSource };

export const TRACE_PULL_CHANNELS = ["prod", "test"] as const;

export type TracePullChannel = (typeof TRACE_PULL_CHANNELS)[number];

export const PULL_ERROR_KINDS = ["network", "auth", "remap", "validation", "conflict"] as const;

export type PullErrorKind = (typeof PULL_ERROR_KINDS)[number];

/**
 * Ids inserted by `seedDemoRunsAndTraces`. The list filter uses the same set
 * when a stored trace omits `source`.
 */
export const DEMO_SEED_TRACE_IDS = [
  "shop-a-prod-t1",
  "shop-a-prod-t3",
  "shop-a-test-t2",
  "lib-b-prod-renew",
  "lib-b-test-return",
  "lib-b-prod-hold",
  "trace-t3-forged-checkout",
] as const;

/** Storyboard scenes 6–8: failed T3 checkout with diagnosis.proposed_fixes. */
export const DEMO_STORYBOARD_TRACE_ID = "trace-t3-forged-checkout";

const DEMO_SEED_TRACE_ID_SET = new Set<string>(DEMO_SEED_TRACE_IDS);

export const TRACE_SOURCE_LABELS: Record<TraceSource, string> = {
  harness: "Harness",
  demo_seed: "Demo seed",
  otel_prod: "OTel prod",
  otel_test: "OTel test",
};

const PULL_ERROR_HINTS: Record<PullErrorKind, string> = {
  network: "Check the traces URL and retry. This source's cursor was not moved.",
  auth: "Set the bearer env var on the lab process and retry. This source's cursor was not moved.",
  remap: "The export does not match this agent's schema remap. This source's cursor was not moved.",
  validation: "The spans did not pass validateTrace. This source's cursor was not moved.",
  conflict: "The stored trace was left unchanged. This source's cursor was not moved.",
};

export interface TraceListFilters {
  agentId: string;
  source: TraceSource | "";
  /** `datetime-local` or ISO. Sent as `since` when set. */
  from: string;
  /** `datetime-local` or ISO. Sent as `until` when set. */
  to: string;
}

export interface TracePullBody {
  sources: TracePullChannel[];
  since?: string;
}

export interface OtelPullError {
  source: TracePullChannel;
  kind: PullErrorKind;
  message: string;
}

export interface OtelPullSourceResult {
  source: TracePullChannel;
  tag: "otel_prod" | "otel_test";
  transport: "http" | "fixture" | "none";
  since: string | null;
  until: string;
  previous_last_pull_at: string | null;
  last_pull_at: string | null;
  imported: number;
  skipped: number;
  failed: number;
  empty: boolean;
  message: string;
  trace_ids: string[];
  errors: OtelPullError[];
}

export interface OtelPullResponse {
  agent_id: string;
  imported: number;
  skipped: number;
  failed: number;
  sources: OtelPullSourceResult[];
  errors: OtelPullError[];
}

export interface OtelPullCursors {
  agent_id: string;
  prod: { tag: "otel_prod"; last_pull_at: string | null };
  test: { tag: "otel_test"; last_pull_at: string | null };
}

export interface PullFailureView {
  message: string;
  details: string | null;
}

export function isTraceSource(value: string | null | undefined): value is TraceSource {
  return typeof value === "string" && (TRACE_SOURCES as readonly string[]).includes(value);
}

export function traceSourceParam(value: string | null): TraceSource | "" {
  return isTraceSource(value) ? value : "";
}

/** Same tag `GET /traces?source=` uses. A stored `source` wins. */
export function traceListSource(trace: Pick<Trace, "source" | "trace_id">): TraceSource {
  if (isTraceSource(trace.source)) return trace.source;
  if (DEMO_SEED_TRACE_ID_SET.has(trace.trace_id)) return "demo_seed";
  return "harness";
}

export function traceListPath(
  filters: TraceListFilters,
): { ok: true; path: string } | { ok: false; message: string } {
  const params = new URLSearchParams();
  if (filters.agentId.trim()) params.set("agent_id", filters.agentId.trim());
  if (filters.source) {
    if (!isTraceSource(filters.source)) {
      return { ok: false, message: "source must be harness, demo_seed, otel_prod, or otel_test." };
    }
    params.set("source", filters.source);
  }
  const since = filterInstant(filters.from, "From");
  if (!since.ok) return since;
  const until = filterInstant(filters.to, "To");
  if (!until.ok) return until;
  if (since.value && until.value && since.value > until.value) {
    return { ok: false, message: "The start of the range is after the end." };
  }
  if (since.value) params.set("since", since.value);
  if (until.value) params.set("until", until.value);
  const query = params.toString();
  return { ok: true, path: query ? `/traces?${query}` : "/traces" };
}

export function parseTraceList(body: unknown): { ok: true; traces: Trace[] } | { ok: false; message: string } {
  if (!isRecord(body) || !Array.isArray(body.traces)) {
    return { ok: false, message: "The lab response did not include a traces list." };
  }
  const traces: Trace[] = [];
  for (let index = 0; index < body.traces.length; index += 1) {
    const item = body.traces[index];
    if (!isRecord(item) || !isTraceIdentity(item)) {
      return {
        ok: false,
        message: `Trace list item ${index} is missing trace_id, agent_id, run_id, task_id, started_at, or status.`,
      };
    }
    if (item.source !== undefined && !isTraceSource(typeof item.source === "string" ? item.source : undefined)) {
      return {
        ok: false,
        message: `Trace list item ${index} has source ${JSON.stringify(item.source)}. Expected harness, demo_seed, otel_prod, or otel_test.`,
      };
    }
    traces.push(item as unknown as Trace);
  }
  return { ok: true, traces };
}

export function sortTracesNewestFirst(traces: readonly Trace[]): Trace[] {
  return [...traces].sort((left, right) => {
    const started = Date.parse(right.started_at) - Date.parse(left.started_at);
    if (Number.isFinite(started) && started !== 0) return started;
    return right.trace_id.localeCompare(left.trace_id);
  });
}

export function describeTraceListFailure(error: unknown): string {
  const http = readHttpError(error);
  if (http) {
    const details = http.code ? `HTTP ${http.status} ${http.code}` : `HTTP ${http.status}`;
    return `${http.message} ${details}`;
  }
  if (error instanceof TypeError || (error instanceof Error && /fetch|network/i.test(error.message))) {
    return "The browser could not reach the lab. Check that the backend is running, then reload.";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Could not load traces.";
}

/**
 * Blank `since` is omitted. The lab then uses `last_pull_at`, or no lower bound
 * when that cursor is still empty.
 */
export function tracePullBody(input: {
  sources: readonly TracePullChannel[];
  since: string;
}): { ok: true; body: TracePullBody } | { ok: false; message: string } {
  const sources = TRACE_PULL_CHANNELS.filter((channel) => input.sources.includes(channel));
  if (sources.length === 0) return { ok: false, message: "Select prod, test, or both." };
  const sinceText = input.since.trim();
  if (!sinceText) return { ok: true, body: { sources } };
  const sinceMs = Date.parse(sinceText);
  if (Number.isNaN(sinceMs)) {
    return { ok: false, message: "Enter a valid start time, or leave it blank to use the stored cursor." };
  }
  return { ok: true, body: { sources, since: new Date(sinceMs).toISOString() } };
}

export function parseTracePullResult(
  body: unknown,
): { ok: true; value: OtelPullResponse } | { ok: false; message: string } {
  if (!isRecord(body)) {
    return { ok: false, message: "The pull response did not include imported, skipped, and failed counts." };
  }
  const imported = readCount(body.imported);
  const skipped = readCount(body.skipped);
  const failed = readCount(body.failed);
  if (typeof body.agent_id !== "string" || body.agent_id.trim() === "" || imported === undefined || skipped === undefined || failed === undefined) {
    return { ok: false, message: "The pull response did not include imported, skipped, and failed counts." };
  }
  if (!Array.isArray(body.sources)) {
    return { ok: false, message: "The pull response did not include a sources list." };
  }
  const sources: OtelPullSourceResult[] = [];
  for (const entry of body.sources) {
    const parsed = parseSourceResult(entry);
    if (!parsed.ok) return parsed;
    sources.push(parsed.value);
  }
  const errors = parsePullErrors(body.errors);
  if (!errors.ok) return errors;
  return {
    ok: true,
    value: { agent_id: body.agent_id, imported, skipped, failed, sources, errors: errors.errors },
  };
}

export function parseOtelPullCursors(
  body: unknown,
): { ok: true; value: OtelPullCursors } | { ok: false; message: string } {
  if (!isRecord(body) || typeof body.agent_id !== "string" || !isRecord(body.prod) || !isRecord(body.test)) {
    return { ok: false, message: "The cursor response did not include prod and test last_pull_at." };
  }
  const prod = parseCursorSide(body.prod, "otel_prod");
  const test = parseCursorSide(body.test, "otel_test");
  if (!prod.ok) return { ok: false, message: prod.message };
  if (!test.ok) return { ok: false, message: test.message };
  return { ok: true, value: { agent_id: body.agent_id, prod: prod.value, test: test.value } };
}

export function formatPullError(error: OtelPullError): string {
  return `${error.source} · ${error.kind}: ${error.message} ${PULL_ERROR_HINTS[error.kind]}`;
}

export function pullResultSummary(result: OtelPullResponse): string {
  const counts = `Imported ${result.imported}. Skipped ${result.skipped}. Failed ${result.failed}.`;
  const empty = result.sources.filter((source) => source.empty);
  if (result.failed > 0 && result.errors.length === 0) {
    return `${counts} The lab reported failures without an error message.`;
  }
  if (empty.length > 0) {
    const detail = empty.map((source) => `${source.source}: ${source.message}`).join(" ");
    return `${counts} Empty window. ${detail}`;
  }
  return counts;
}

export function formatCursor(value: string | null): string {
  return value ?? "No successful pull yet";
}

export function describePullFailure(error: unknown): PullFailureView {
  const http = readHttpError(error);
  if (http) {
    const hint =
      http.code === "otel_not_configured"
        ? " Register otel.prod and otel.test on the agent, then retry."
        : http.status === 400
          ? " Fix the request and retry. The list was not cleared."
          : http.status === 404
            ? " Check the agent id and retry."
            : "";
    return {
      message: `${http.message}${hint}`,
      details: http.code ? `HTTP ${http.status} ${http.code}` : `HTTP ${http.status}`,
    };
  }
  if (error instanceof TypeError || (error instanceof Error && /fetch|network/i.test(error.message))) {
    return {
      message: "The browser could not reach the lab. Check that the backend is running, then retry the pull.",
      details: error instanceof Error ? error.message : null,
    };
  }
  if (error instanceof Error && error.message.trim()) return { message: error.message, details: null };
  return { message: "The pull failed.", details: null };
}

function parseSourceResult(
  entry: unknown,
): { ok: true; value: OtelPullSourceResult } | { ok: false; message: string } {
  if (!isRecord(entry)) return { ok: false, message: "A pull source result was not an object." };
  const source = entry.source === "prod" || entry.source === "test" ? entry.source : undefined;
  const tag = entry.tag === "otel_prod" || entry.tag === "otel_test" ? entry.tag : undefined;
  const transport = entry.transport === "http" || entry.transport === "fixture" || entry.transport === "none" ? entry.transport : undefined;
  const imported = readCount(entry.imported);
  const skipped = readCount(entry.skipped);
  const failed = readCount(entry.failed);
  if (!source || !tag || !transport || imported === undefined || skipped === undefined || failed === undefined || typeof entry.empty !== "boolean" || typeof entry.message !== "string") {
    return { ok: false, message: "A pull source result is missing its counts, empty flag, or message." };
  }
  if (entry.since !== null && typeof entry.since !== "string") {
    return { ok: false, message: "A pull source since value is not a time." };
  }
  if (typeof entry.until !== "string" || (entry.last_pull_at !== null && typeof entry.last_pull_at !== "string") || (entry.previous_last_pull_at !== null && typeof entry.previous_last_pull_at !== "string")) {
    return { ok: false, message: "A pull source cursor time is missing." };
  }
  if (!Array.isArray(entry.trace_ids) || entry.trace_ids.some((id) => typeof id !== "string")) {
    return { ok: false, message: "A pull source trace_ids list is missing." };
  }
  const errors = parsePullErrors(entry.errors);
  if (!errors.ok) return errors;
  return {
    ok: true,
    value: {
      source,
      tag,
      transport,
      since: entry.since,
      until: entry.until,
      previous_last_pull_at: entry.previous_last_pull_at,
      last_pull_at: entry.last_pull_at,
      imported,
      skipped,
      failed,
      empty: entry.empty,
      message: entry.message,
      trace_ids: entry.trace_ids,
      errors: errors.errors,
    },
  };
}

function parsePullErrors(value: unknown): { ok: true; errors: OtelPullError[] } | { ok: false; message: string } {
  if (!Array.isArray(value)) return { ok: false, message: "The pull response errors field is not a list." };
  const errors: OtelPullError[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || (entry.source !== "prod" && entry.source !== "test") || typeof entry.message !== "string" || entry.message.trim() === "") {
      return { ok: false, message: "A pull error is missing source or message." };
    }
    if (!isPullErrorKind(entry.kind)) {
      return { ok: false, message: `A pull error has kind ${JSON.stringify(entry.kind)}. Expected network, auth, remap, validation, or conflict.` };
    }
    errors.push({ source: entry.source, kind: entry.kind, message: entry.message });
  }
  return { ok: true, errors };
}

function parseCursorSide<T extends "otel_prod" | "otel_test">(
  value: Record<string, unknown>,
  tag: T,
): { ok: true; value: { tag: T; last_pull_at: string | null } } | { ok: false; message: string } {
  if (value.tag !== tag) return { ok: false, message: `Cursor tag ${JSON.stringify(value.tag)} is not ${tag}.` };
  if (value.last_pull_at !== null && typeof value.last_pull_at !== "string") {
    return { ok: false, message: "last_pull_at must be a time or null." };
  }
  return { ok: true, value: { tag, last_pull_at: value.last_pull_at } };
}

function filterInstant(
  value: string,
  label: "From" | "To",
): { ok: true; value?: string } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return { ok: false, message: `${label} must be a valid time.` };
  return { ok: true, value: new Date(ms).toISOString() };
}

function isTraceIdentity(value: Record<string, unknown>): boolean {
  return ["trace_id", "agent_id", "run_id", "task_id", "started_at", "status"].every(
    (key) => typeof value[key] === "string" && (value[key] as string).trim() !== "",
  );
}

function isPullErrorKind(value: unknown): value is PullErrorKind {
  return typeof value === "string" && (PULL_ERROR_KINDS as readonly string[]).includes(value);
}

function readCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
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
