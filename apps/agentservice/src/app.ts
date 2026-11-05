import { CONTRACT_VERSION, GROK_FORBIDDEN_WRITE_PATHS } from "@mesa/shared";
import Fastify from "fastify";
import { DiagnosisFailed, diagnoseTrace } from "./diagnosis/diagnose.js";
import type { DiagnosisModel } from "./diagnosis/diagnose.js";
import { parseDiagnoseRequest } from "./diagnosis/request.js";
import {
  EvalsetGenerateError,
  generateEvalset,
  parseEvalsetGenerateRequest,
  stubEvalset,
} from "./evalset/generate.js";
import { createEvalsetGrokModel } from "./evalset/model.js";
import { readEvalsetStub } from "./evalset/stub.js";
import { createGrokModel } from "./grok/client.js";
import { parseDiagnosisConfig } from "./grok/config.js";
import type { DiagnosisConfig } from "./grok/config.js";
import { UnsupportedTaskError, parseTaskRun, planTaskRun } from "./reference-agent/plan.js";

export interface AppDeps {
  config?: DiagnosisConfig;
  /** Pass `null` to force "not configured". Omit to build a client when a key is present. */
  model?: DiagnosisModel | null;
  /** Separate from diagnosis: evalset completions use a TaskEvalset JSON schema. */
  evalsetModel?: DiagnosisModel | null;
  evalsetStub?: boolean;
  logger?: boolean;
}

/**
 * Agent service.
 * `POST /diagnose` writes `Trace.diagnosis` only.
 * The body is a Trace, or `{ trace, evalset? }` when the caller resolved a task evalset.
 * `POST /evalset/generate` proposes a TaskEvalset. It does not save an Agent.
 * `POST /v1/tasks/run` proposes tool actions with `executed: false`,
 * plus `refused` and `embedded` from the shared plan.
 * The harness executes `actions`, injects faults, and writes `outcome.verifier`.
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
  const evalsetStub = deps.evalsetStub ?? readEvalsetStub();
  const evalsetModel =
    deps.evalsetModel !== undefined
      ? deps.evalsetModel
      : evalsetStub
        ? null
        : config.apiKey
          ? createEvalsetGrokModel({
              apiKey: config.apiKey,
              baseUrl: config.baseUrl,
              timeoutMs: config.timeoutMs,
            })
          : null;
  const app = Fastify({ logger: deps.logger ?? true });

  app.get("/", async () => ({
    service: "agentservice",
    message:
      "MESA Agent Failure Lab agent service. POST /diagnose fills Trace.diagnosis. POST /evalset/generate proposes a task evalset. POST /v1/tasks/run proposes actions for the harness. See GET /health.",
    contract_version: CONTRACT_VERSION,
  }));

  app.get("/health", async () => ({
    status: "ok",
    service: "agentservice",
    role: "grok-reference-agent",
    grok_configured: Boolean(config.apiKey),
    evalset_stub: evalsetStub,
    contract_version: CONTRACT_VERSION,
    forbidden_write_paths: GROK_FORBIDDEN_WRITE_PATHS,
  }));

  app.post("/v1/tasks/run", async (request, reply) => {
    const parsed = parseTaskRun(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.message });
    }
    try {
      return planTaskRun(parsed.value);
    } catch (error) {
      if (error instanceof UnsupportedTaskError) {
        return reply.code(400).send({ error: "unsupported_task", message: error.message });
      }
      throw error;
    }
  });

  app.post("/diagnose", async (request, reply) => {
    const parsed = parseDiagnoseRequest(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error, errors: parsed.errors });
    }
    if (model === null) {
      return reply.code(503).send({ error: "grok_not_configured" });
    }
    try {
      return await diagnoseTrace(parsed.value.trace, {
        model,
        modelName: config.modelName,
        evalset: parsed.value.evalset,
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

  app.post("/evalset/generate", async (request, reply) => {
    const parsed = parseEvalsetGenerateRequest(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({
        error: parsed.error,
        message: parsed.message,
        errors: parsed.errors,
      });
    }
    if (evalsetStub) {
      try {
        return stubEvalset(parsed.value);
      } catch (error) {
        if (error instanceof EvalsetGenerateError) {
          return reply.code(502).send({ error: error.code, errors: error.errors });
        }
        throw error;
      }
    }
    if (evalsetModel === null) {
      return reply.code(503).send({ error: "grok_not_configured" });
    }
    try {
      return await generateEvalset(parsed.value, {
        model: evalsetModel,
        modelName: config.modelName,
        timeoutMs: config.timeoutMs,
        onUsage(usage) {
          request.log.info({ evalset_usage: usage }, "evalset generation usage");
        },
      });
    } catch (error) {
      if (error instanceof EvalsetGenerateError) {
        request.log.error({ code: error.code }, "evalset generation failed");
        if (error.code === "evalset_timeout") {
          return reply.code(504).send({ error: error.code });
        }
        if (error.code === "invalid_evalset") {
          return reply.code(502).send({ error: error.code, errors: error.errors });
        }
        return reply.code(502).send({ error: error.code });
      }
      throw error;
    }
  });

  return app;
}
