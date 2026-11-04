import { CONTRACT_VERSION, GROK_FORBIDDEN_WRITE_PATHS, type Agent, type RunPhase } from "@mesa/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { FAULT_CATALOG, TASK_FAULT_PRESETS } from "./injector/catalog.js";
import { createHttpMockClient, type MockShopClient } from "./mock/client.js";
import { ContractError, MemoryStore, type RunStore } from "./persistence/memory.js";
import { loadReferenceAgent } from "./reference-agent.js";
import { runTasks, type DriverMode, type InjectionRequest } from "./harness/runner.js";
import { isRecord } from "./util.js";

export interface BuildAppOptions {
  logger?: boolean;
  store?: RunStore;
  agent?: Agent;
  mockBaseUrl?: string;
  mock?: MockShopClient;
}

/**
 * Harness API. This process is not the mock shop.
 * `outcome.verifier` is written by the verifier. `fault.labels` are written by the injector.
 * `diagnosis` stays null. Grok is not called here.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const store = options.store ?? new MemoryStore();
  const mockBaseUrl = options.mockBaseUrl ?? process.env.MOCK_SHOP_URL ?? "http://127.0.0.1:8787";
  const agent = options.agent ?? loadReferenceAgent();
  const mock = options.mock ?? createHttpMockClient(mockBaseUrl);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: "not_found",
      message: `No route ${request.method} ${request.url}`,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const message = error instanceof Error ? error.message : "Internal harness error";
    reply.code(500).send({ error: "error", message });
  });

  app.get("/", async () => ({
    service: "backend",
    message: "MESA Agent Failure Lab harness. See GET /health.",
    contract_version: CONTRACT_VERSION,
  }));

  app.get("/health", async () => ({
    status: "ok",
    service: "backend",
    role: "harness",
    contract_version: CONTRACT_VERSION,
    mock_base_url: mockBaseUrl,
    grok_forbidden_write_paths: GROK_FORBIDDEN_WRITE_PATHS,
  }));

  app.get("/faults", async () => ({
    faults: FAULT_CATALOG.map((entry) => ({
      code: entry.code,
      category: entry.category,
      target: entry.target,
      fault: entry.fault,
      effect: entry.effect,
    })),
    presets: TASK_FAULT_PRESETS,
  }));

  app.get("/runs", async () => ({ runs: store.listRuns() }));

  app.get<{ Params: { runId: string } }>("/runs/:runId", async (request, reply) => {
    const run = store.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: "not_found", message: `No run ${request.params.runId}` });
    return run;
  });

  app.get("/traces", async () => ({ traces: store.listTraces() }));

  app.get<{ Params: { traceId: string } }>("/traces/:traceId", async (request, reply) => {
    const trace = store.getTrace(request.params.traceId);
    if (!trace) {
      return reply.code(404).send({ error: "not_found", message: `No trace ${request.params.traceId}` });
    }
    return trace;
  });

  app.post("/runs", async (request, reply) => {
    const parsed = parseRunRequest(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request", message: parsed.message });
    try {
      const results = await runTasks({
        agent,
        store,
        mock,
        mockBaseUrl,
        phase: parsed.value.phase,
        taskIds: parsed.value.taskIds,
        driver: parsed.value.driver,
        injection: parsed.value.injection,
        fixKinds: parsed.value.fixKinds,
        parentRunId: parsed.value.parentRunId,
        grantCancel: parsed.value.grantCancel,
        timeoutMs: parsed.value.timeoutMs,
      });
      return { results };
    } catch (error) {
      if (error instanceof ContractError) {
        return reply.code(500).send({ error: "error", message: error.message });
      }
      const message = error instanceof Error ? error.message : "Bad request";
      return reply.code(400).send({ error: "invalid_request", message });
    }
  });

  return app;
}

interface RunRequest {
  phase: RunPhase;
  taskIds?: string[];
  driver?: DriverMode;
  injection?: InjectionRequest;
  fixKinds?: string[];
  parentRunId?: string | null;
  grantCancel?: boolean;
  timeoutMs?: number;
}

function parseRunRequest(body: unknown): { ok: true; value: RunRequest } | { ok: false; message: string } {
  if (body === undefined || body === null) {
    return { ok: true, value: { phase: "baseline" } };
  }
  if (!isRecord(body)) return { ok: false, message: "Body must be a JSON object." };

  const phase = body.phase === undefined ? "baseline" : body.phase;
  if (phase !== "baseline" && phase !== "injected" && phase !== "after_fix") {
    return { ok: false, message: "phase must be baseline, injected, or after_fix." };
  }

  let taskIds: string[] | undefined;
  if (body.task_ids !== undefined) {
    if (!Array.isArray(body.task_ids) || body.task_ids.some((id) => typeof id !== "string" || id.trim() === "")) {
      return { ok: false, message: "task_ids must be an array of strings." };
    }
    taskIds = body.task_ids;
  }

  let driver: DriverMode | undefined;
  if (body.driver !== undefined) {
    if (body.driver !== "scripted" && body.driver !== "http" && body.driver !== "auto") {
      return { ok: false, message: "driver must be scripted, http, or auto." };
    }
    driver = body.driver;
  }

  let injection: InjectionRequest | undefined;
  if (body.injection !== undefined) {
    if (body.injection === null) injection = null;
    else if (body.injection === "preset") injection = "preset";
    else if (isRecord(body.injection)) injection = body.injection;
    else return { ok: false, message: "injection must be preset, an object, or null." };
  }

  let fixKinds: string[] | undefined;
  if (body.fix_kinds !== undefined) {
    if (!Array.isArray(body.fix_kinds) || body.fix_kinds.some((kind) => typeof kind !== "string")) {
      return { ok: false, message: "fix_kinds must be an array of strings." };
    }
    fixKinds = body.fix_kinds;
  }

  let parentRunId: string | null | undefined;
  if (body.parent_run_id !== undefined) {
    if (body.parent_run_id !== null && (typeof body.parent_run_id !== "string" || body.parent_run_id.trim() === "")) {
      return { ok: false, message: "parent_run_id must be a string or null." };
    }
    parentRunId = body.parent_run_id;
  }

  if (body.grant_cancel !== undefined && typeof body.grant_cancel !== "boolean") {
    return { ok: false, message: "grant_cancel must be a boolean." };
  }

  let timeoutMs: number | undefined;
  if (body.timeout_ms !== undefined) {
    if (typeof body.timeout_ms !== "number" || !Number.isInteger(body.timeout_ms) || body.timeout_ms < 0) {
      return { ok: false, message: "timeout_ms must be an integer >= 0." };
    }
    timeoutMs = body.timeout_ms;
  }

  return {
    ok: true,
    value: {
      phase,
      taskIds,
      driver,
      injection,
      fixKinds,
      parentRunId,
      grantCancel: typeof body.grant_cancel === "boolean" ? body.grant_cancel : undefined,
      timeoutMs,
    },
  };
}
