import { validateTrace } from "@mesa/shared/validate";
import type { FastifyInstance } from "fastify";
import { DuplicateTraceError, type RunStore } from "../persistence/store.js";

/**
 * Request body cap for POST /traces.
 * Matches Fastify's default (1 MiB). Documented so the FE can fail closed before upload.
 */
export const TRACE_IMPORT_BODY_LIMIT = 1_048_576;

export const PRODUCTION_FAULT_FORBIDDEN = "fault_forbidden";

const PRODUCTION_FAULT_MESSAGE =
  "Production import cannot include injector or attacker fault.* (ADR-002). Send fault.injected false, fault.labels [], and fault.attacker { used: false, payload_id: null }.";

function hasForbiddenProductionFault(trace: {
  fault: { injected: boolean; labels: unknown[]; attacker: { used: boolean } };
}): boolean {
  return trace.fault.injected || trace.fault.labels.length > 0 || trace.fault.attacker.used;
}

/**
 * POST /traces — persist a pasted/uploaded production Trace.
 * Does not conflict with GET /traces, GET /traces/:traceId, or POST /traces/:traceId/diagnose.
 * Does not take the mock-world gate. Does not create a Run row.
 */
export function registerTraceImportRoutes(app: FastifyInstance, store: RunStore): void {
  app.post(
    "/traces",
    {
      bodyLimit: TRACE_IMPORT_BODY_LIMIT,
      errorHandler(error, _request, reply) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        const statusCode =
          typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
            ? error.statusCode
            : undefined;
        if (code === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413) {
          return reply.code(413).send({
            error: "payload_too_large",
            message: `Trace JSON must be at most ${TRACE_IMPORT_BODY_LIMIT} bytes.`,
          });
        }
        const status = statusCode !== undefined && statusCode >= 400 && statusCode < 500 ? statusCode : 400;
        const message = error instanceof Error ? error.message : "Invalid request.";
        return reply.code(status).send({ error: "invalid_request", message });
      },
    },
    async (request, reply) => {
      const parsed = validateTrace(request.body);
      if (!parsed.ok) {
        return reply.code(400).send({
          error: "invalid_trace",
          message: parsed.errors.join("; "),
          errors: parsed.errors,
        });
      }
      if (hasForbiddenProductionFault(parsed.value)) {
        return reply.code(400).send({
          error: PRODUCTION_FAULT_FORBIDDEN,
          message: PRODUCTION_FAULT_MESSAGE,
        });
      }
      const stored = { ...parsed.value, source: "production" as const };
      try {
        const saved = await store.insertTrace(stored);
        return reply.code(201).send(saved);
      } catch (error) {
        if (error instanceof DuplicateTraceError) {
          return reply.code(409).send({ error: "conflict", message: error.message });
        }
        throw error;
      }
    },
  );
}
