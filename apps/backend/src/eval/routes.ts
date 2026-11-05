import type { FastifyInstance } from "fastify";
import { resolveAgentserviceProxy, type EvalsetGenerateOptions } from "../evalset/routes.js";

class EvalResultsProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageText?: string,
  ) {
    super(code);
  }
}

/**
 * Browser-facing proxy for GET /eval/results.
 * Same AGENTSERVICE_URL and EVALSET_TIMEOUT_MS as POST /evalset/generate.
 */
export function registerEvalResultsRoutes(app: FastifyInstance, options: EvalsetGenerateOptions = {}): void {
  const upstream = resolveAgentserviceProxy(options);
  app.get("/eval/results", async (request, reply) => {
    try {
      return await forwardResults(upstream);
    } catch (error) {
      const failure =
        error instanceof EvalResultsProxyError ? error : new EvalResultsProxyError(502, "eval_results_upstream_error");
      request.log.warn({ eval_results_error: failure.code }, "eval results proxy failed");
      const body: Record<string, unknown> = { error: failure.code };
      if (failure.messageText) body.message = failure.messageText;
      return reply.code(failure.status).send(body);
    }
  });
}

async function forwardResults(upstream: ReturnType<typeof resolveAgentserviceProxy>): Promise<unknown> {
  if (!upstream.baseUrl) throw new EvalResultsProxyError(503, "eval_results_not_configured");
  const signal = AbortSignal.timeout(upstream.timeoutMs);
  let value: unknown;
  try {
    const response = await upstream.fetchImpl(`${upstream.baseUrl}/eval/results`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
      redirect: "error",
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      throw new EvalResultsProxyError(502, "eval_results_upstream_error");
    }
    if (response.status === 404) {
      const record = isRecord(parsed) ? parsed : {};
      throw new EvalResultsProxyError(
        404,
        typeof record.error === "string" ? record.error : "eval_results_not_found",
        typeof record.message === "string" ? record.message : undefined,
      );
    }
    if (response.status === 503) throw new EvalResultsProxyError(503, "eval_results_unavailable");
    if (response.status === 504) throw new EvalResultsProxyError(504, "eval_results_timeout");
    if (!response.ok) throw new EvalResultsProxyError(502, "eval_results_upstream_error");
    value = parsed;
  } catch (error) {
    if (error instanceof EvalResultsProxyError) throw error;
    if (signal.aborted) throw new EvalResultsProxyError(504, "eval_results_timeout");
    throw new EvalResultsProxyError(502, "eval_results_upstream_error");
  }
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.metrics) || !isRecord(value.dataset)) {
    throw new EvalResultsProxyError(502, "invalid_eval_results_response");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
