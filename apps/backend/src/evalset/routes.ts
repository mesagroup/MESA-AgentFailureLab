import type { FastifyInstance } from "fastify";

export interface EvalsetGenerateOptions {
  /** Undefined reads AGENTSERVICE_URL. Null disables upstream calls. */
  baseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

class EvalsetProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly errors?: string[],
    readonly messageText?: string,
  ) {
    super(code);
  }
}

export function resolveAgentserviceProxy(options: EvalsetGenerateOptions) {
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
  const timeoutMs = options.timeoutMs ?? Number(process.env.EVALSET_TIMEOUT_MS?.trim() || 45_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("Invalid EVALSET_TIMEOUT_MS: expected an integer from 1 to 300000.");
  }
  return { baseUrl, timeoutMs, fetchImpl: options.fetchImpl ?? fetch };
}

/**
 * Browser-facing proxy. The Grok key stays on agentservice.
 * This route does not persist an Agent or write outcome.verifier.
 */
export function registerEvalsetRoutes(app: FastifyInstance, options: EvalsetGenerateOptions = {}): void {
  const upstream = resolveAgentserviceProxy(options);
  app.post("/evalset/generate", async (request, reply) => {
    try {
      const result = await forwardGenerate(request.body, upstream);
      return result;
    } catch (error) {
      const failure = error instanceof EvalsetProxyError ? error : new EvalsetProxyError(502, "evalset_upstream_error");
      request.log.warn({ evalset_error: failure.code }, "evalset generate proxy failed");
      const body: Record<string, unknown> = { error: failure.code };
      if (failure.messageText) body.message = failure.messageText;
      if (failure.errors) body.errors = failure.errors;
      return reply.code(failure.status).send(body);
    }
  });
}

async function forwardGenerate(
  body: unknown,
  upstream: ReturnType<typeof resolveAgentserviceProxy>,
): Promise<unknown> {
  if (!upstream.baseUrl) throw new EvalsetProxyError(503, "evalset_not_configured");
  const signal = AbortSignal.timeout(upstream.timeoutMs);
  let value: unknown;
  try {
    const response = await upstream.fetchImpl(`${upstream.baseUrl}/evalset/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal,
      redirect: "error",
    });
    if (response.status === 503) throw new EvalsetProxyError(503, "evalset_unavailable");
    if (response.status === 504) throw new EvalsetProxyError(504, "evalset_timeout");
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      throw new EvalsetProxyError(502, "evalset_upstream_error");
    }
    if (response.status === 400) {
      const record = isRecord(parsed) ? parsed : {};
      throw new EvalsetProxyError(
        400,
        typeof record.error === "string" ? record.error : "invalid_request",
        stringList(record.errors),
        typeof record.message === "string" ? record.message : undefined,
      );
    }
    if (response.status === 502) {
      const record = isRecord(parsed) ? parsed : {};
      const code = typeof record.error === "string" ? record.error : "evalset_upstream_error";
      throw new EvalsetProxyError(502, code, stringList(record.errors));
    }
    if (!response.ok) throw new EvalsetProxyError(502, "evalset_upstream_error");
    value = parsed;
  } catch (error) {
    if (error instanceof EvalsetProxyError) throw error;
    if (signal.aborted) throw new EvalsetProxyError(504, "evalset_timeout");
    throw new EvalsetProxyError(502, "evalset_upstream_error");
  }
  if (!isRecord(value) || !("evalset" in value)) {
    throw new EvalsetProxyError(502, "invalid_evalset_response");
  }
  return value;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
