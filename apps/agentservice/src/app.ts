import { CONTRACT_VERSION, GROK_FORBIDDEN_WRITE_PATHS } from "@mesa/shared";
import { validateTrace } from "@mesa/shared/validate";
import Fastify from "fastify";
import { DiagnosisFailed, diagnoseTrace } from "./diagnosis/diagnose.js";
import type { DiagnosisModel } from "./diagnosis/diagnose.js";
import { createGrokModel } from "./grok/client.js";
import { parseDiagnosisConfig } from "./grok/config.js";
import type { DiagnosisConfig } from "./grok/config.js";

export interface AppDeps {
  config?: DiagnosisConfig;
  /** Pass `null` to force "not configured". Omit to build a client when a key is present. */
  model?: DiagnosisModel | null;
  logger?: boolean;
}

/**
 * Agent service. `POST /diagnose` writes `Trace.diagnosis` only.
 */
export function buildApp(deps: AppDeps = {}) {
  const config = deps.config ?? parseDiagnosisConfig(process.env);
  const model =
    deps.model !== undefined
      ? deps.model
      : config.apiKey
        ? createGrokModel({
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            timeoutMs: config.timeoutMs,
          })
        : null;
  const app = Fastify({ logger: deps.logger ?? true });

  app.get("/", async () => ({
    service: "agentservice",
    message: "MESA Agent Failure Lab agent service. POST /diagnose fills Trace.diagnosis. See GET /health.",
    contract_version: CONTRACT_VERSION,
  }));

  app.get("/health", async () => ({
    status: "ok",
    service: "agentservice",
    role: "grok-reference-agent",
    grok_configured: Boolean(config.apiKey),
    contract_version: CONTRACT_VERSION,
    forbidden_write_paths: GROK_FORBIDDEN_WRITE_PATHS,
  }));

  app.post("/diagnose", async (request, reply) => {
    const parsed = validateTrace(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ error: "invalid_trace", errors: parsed.errors });
    }
    if (model === null) {
      return reply.code(503).send({ error: "grok_not_configured" });
    }
    try {
      return await diagnoseTrace(parsed.value, {
        model,
        modelName: config.modelName,
        onUsage(usage) {
          request.log.info({ diagnosis_usage: usage }, "diagnosis usage");
        },
      });
    } catch (error) {
      if (error instanceof DiagnosisFailed) {
        request.log.error({ code: error.code }, "diagnosis failed");
        return reply.code(502).send({ error: "diagnosis_failed" });
      }
      throw error;
    }
  });

  return app;
}
