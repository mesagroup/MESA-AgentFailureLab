import { TRACE_SOURCES, describeTraceSources, type Trace, type TraceSource } from "@mesa/shared";
import { DEMO_SEED_TRACE_IDS } from "../persistence/demo-seed.js";
import { isRecord } from "../util.js";

const demoTraceIds = new Set<string>(DEMO_SEED_TRACE_IDS);

/**
 * Tag used by `GET /traces?source=`.
 * A stored `source` wins. A demo seed id without the field is `demo_seed`.
 * Any other omission is `harness`. The stored document is not rewritten.
 */
export function traceListSource(trace: Pick<Trace, "source" | "trace_id">): TraceSource {
  if (trace.source) return trace.source;
  if (demoTraceIds.has(trace.trace_id)) return "demo_seed";
  return "harness";
}

export interface TraceListQuery {
  agentId?: string;
  source?: TraceSource;
  since?: string;
  until?: string;
}

export function parseTraceListQuery(
  query: unknown,
): { ok: true; value: TraceListQuery } | { ok: false; message: string } {
  if (query === undefined || query === null) return { ok: true, value: {} };
  if (!isRecord(query)) return { ok: false, message: "Query must be an object." };
  const value: TraceListQuery = {};
  if (query.agent_id !== undefined) {
    if (typeof query.agent_id !== "string" || query.agent_id.trim() === "") {
      return { ok: false, message: "agent_id must be a non-empty string." };
    }
    value.agentId = query.agent_id;
  }
  if (query.source !== undefined) {
    if (typeof query.source !== "string" || !(TRACE_SOURCES as readonly string[]).includes(query.source)) {
      return { ok: false, message: `source must be ${describeTraceSources()}.` };
    }
    value.source = query.source as TraceSource;
  }
  if (query.since !== undefined) {
    const since = parseInstant(query.since, "since");
    if (!since.ok) return since;
    value.since = since.value;
  }
  if (query.until !== undefined) {
    const until = parseInstant(query.until, "until");
    if (!until.ok) return until;
    value.until = until.value;
  }
  return { ok: true, value };
}

export function filterTraces(traces: readonly Trace[], query: TraceListQuery): Trace[] {
  return traces.filter((trace) => {
    if (query.agentId !== undefined && trace.agent_id !== query.agentId) return false;
    if (query.source !== undefined && traceListSource(trace) !== query.source) return false;
    if (query.since !== undefined && trace.started_at < query.since) return false;
    if (query.until !== undefined && trace.started_at > query.until) return false;
    return true;
  });
}

function parseInstant(value: unknown, label: string): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || !value.includes("T")) {
    return { ok: false, message: `${label} must be an ISO-8601 date-time.` };
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { ok: false, message: `${label} must be an ISO-8601 date-time.` };
  return { ok: true, value: parsed.toISOString() };
}
