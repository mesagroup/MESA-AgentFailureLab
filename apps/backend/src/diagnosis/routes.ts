import { isDeepStrictEqual } from "node:util";
import type { Diagnosis, TaskEvalset, Trace } from "@mesa/shared";
import { validateTrace } from "@mesa/shared/validate";
import type { FastifyInstance } from "fastify";
import type { AgentStore } from "../agents/store.js";
import type { RunStore } from "../persistence/store.js";

export interface DiagnosisOptions {
  /** Undefined reads AGENTSERVICE_URL. Null explicitly disables upstream calls. */
  baseUrl?: string | null;
  /** Includes reading the response body. Defaults to 45 seconds. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// Shared by apps using the same store; not a world/mock lock. PostgreSQL CAS
// also rejects stale writes from another process, but cannot prevent its cost.
const activeByStore = new WeakMap<RunStore, Set<string>>();

class DiagnosisError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function config(options: DiagnosisOptions) {
  const raw = options.baseUrl === undefined ? process.env.AGENTSERVICE_URL?.trim() : options.baseUrl;
  let baseUrl: string | null = null;
  if (raw) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("Invalid AGENTSERVICE_URL.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Invalid AGENTSERVICE_URL: use an http(s) base URL without credentials, query or fragment.");
    }
    baseUrl = url.href.replace(/\/+$/, "");
  }
  const timeoutMs = options.timeoutMs ?? Number(process.env.DIAGNOSIS_TIMEOUT_MS?.trim() || 45_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("Invalid DIAGNOSIS_TIMEOUT_MS: expected an integer from 1 to 300000.");
  }
  return { baseUrl, timeoutMs, fetchImpl: options.fetchImpl ?? fetch };
}

async function resolveTaskEvalset(agents: AgentStore, trace: Trace): Promise<TaskEvalset | undefined> {
  try {
    const agent = await agents.get(trace.agent_id);
    return agent?.tasks.find((task) => task.task_id === trace.task_id)?.evalset;
  } catch {
    return undefined;
  }
}

function diagnoseUpstreamBody(trace: Trace, evalset: TaskEvalset | undefined): Trace | { trace: Trace; evalset: TaskEvalset } {
  return evalset === undefined ? trace : { trace, evalset };
}

async function requestDiagnosis(
  trace: Trace,
  evalset: TaskEvalset | undefined,
  upstream: ReturnType<typeof config>,
): Promise<Diagnosis> {
  if (!upstream.baseUrl) throw new DiagnosisError(503, "diagnosis_not_configured");
  const signal = AbortSignal.timeout(upstream.timeoutMs);
  let value: unknown;
  try {
    const response = await upstream.fetchImpl(`${upstream.baseUrl}/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(diagnoseUpstreamBody(trace, evalset)),
      signal,
      redirect: "error",
    });
    if (response.status === 503) throw new DiagnosisError(503, "diagnosis_unavailable");
    if (!response.ok) throw new DiagnosisError(502, "diagnosis_upstream_error");
    value = await response.json();
  } catch (error) {
    if (error instanceof DiagnosisError) throw error;
    if (signal.aborted) throw new DiagnosisError(504, "diagnosis_timeout");
    throw new DiagnosisError(502, "diagnosis_upstream_error");
  }
  const parsed = validateTrace(value);
  if (!parsed.ok || parsed.value.diagnosis === null) {
    throw new DiagnosisError(502, "invalid_diagnosis_response");
  }
  const { diagnosis, ...protectedAfter } = parsed.value;
  const { diagnosis: _previous, ...protectedBefore } = trace;
  if (!isDeepStrictEqual(protectedBefore, protectedAfter)) {
    throw new DiagnosisError(502, "invalid_diagnosis_response");
  }
  const stepIds = new Set(trace.steps.map((step) => step.step_id));
  if (!stepIds.has(diagnosis.step_id)) throw new DiagnosisError(502, "invalid_diagnosis_response");
  return diagnosis;
}

/** Opt-in diagnosis of a stored trace. Does not execute a run or touch the mock. */
export function registerDiagnosisRoutes(
  app: FastifyInstance,
  store: RunStore,
  agents: AgentStore,
  options: DiagnosisOptions = {},
): void {
  const upstream = config(options);
  let active = activeByStore.get(store);
  if (!active) {
    active = new Set();
    activeByStore.set(store, active);
  }
  const inFlight = active;
  app.post<{ Params: { traceId: string } }>("/traces/:traceId/diagnose", {
    // Keep parser/body errors on this route out of the app's generic 500 handler.
    errorHandler(error, _request, reply) {
      const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
      reply.code(status).send({ error: status < 500 ? "invalid_request" : "diagnosis_store_error" });
    },
  }, async (request, reply) => {
    // No Trace, URL or arbitrary diagnosis is accepted from the caller.
    const body = request.body;
    if (
      body !== undefined &&
      (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0)
    ) {
      return reply.code(400).send({ error: "invalid_request", message: "Send no body or an empty JSON object." });
    }
    const traceId = request.params.traceId;
    if (inFlight.has(traceId)) return reply.code(409).send({ error: "diagnosis_busy" });
    inFlight.add(traceId);
    const started = performance.now();
    try {
      const original = await store.getTrace(traceId);
      if (!original) return reply.code(404).send({ error: "not_found", message: "Trace not found." });
      if (original.diagnosis !== null) {
        return reply.header("x-diagnosis-cached", "true").send(original);
      }
      const evalset = await resolveTaskEvalset(agents, original);
      const diagnosis = await requestDiagnosis(original, evalset, upstream);
      const saved = await store.saveDiagnosis(original, diagnosis);
      if (!saved) return reply.code(409).send({ error: "trace_changed" });
      return reply.header("x-diagnosis-cached", "false")
        .header("x-diagnosis-duration-ms", Math.round(performance.now() - started).toString())
        .send(saved);
    } catch (error) {
      // Never log upstream bodies, trace content, URLs, credentials or raw errors.
      const failure = error instanceof DiagnosisError ? error : new DiagnosisError(500, "diagnosis_store_error");
      request.log.warn({ diagnosis_error: failure.code }, "diagnosis request failed");
      return reply.code(failure.status).send({ error: failure.code });
    } finally {
      inFlight.delete(traceId);
    }
  });
}
