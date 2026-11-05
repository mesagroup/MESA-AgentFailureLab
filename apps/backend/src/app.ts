import { FEATURES } from "@mesa/shared/robot-lab";
import { registerRobotRuns } from "./robot-lab/routes.js";
import {
  AGENT_RUNTIME_LABELS,
  CONTRACT_VERSION,
  GROK_AGENT_HTTP_TIMEOUT_MS,
  GROK_ATTACKER_HARNESS_TIMEOUT_MS,
  GROK_FIX_RUN_TIMEOUT_MS,
  GROK_RUN_TIMEOUT_MS,
  GROK_FORBIDDEN_WRITE_PATHS,
  agentRuntimeLine,
  type Agent,
  type AgentRuntimeLabel,
  type RunPhase,
} from "@mesa/shared";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { describeJuryCase } from "./attacker/jury-note.js";
import { runJuryCase } from "./attacker/run-case.js";
import { parseAgentResponse, tasksRunUrl, type AgentRunRequest } from "./agent/http.js";
import { publicErrorMessage } from "./net/fetch-error.js";
import { fetchWithTransientRetry } from "./net/transient-fetch.js";
import { agentUsesShopPlanner, anyPlannerRequested, plannerFlagForRole, runtimeSnapshot, flagRequestsGrok, type PlannerRole } from "./agent/runtime.js";
import { acceptWhenGated, readAgentJob } from "./harness/grok-job.js";
import { FAULT_CATALOG, TASK_FAULT_PRESETS } from "./injector/catalog.js";
import { createHttpMockClient, type MockShopClient } from "./mock/client.js";
import { mockBaseUrlForAgent } from "./agents/endpoints.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { MemoryAgentStore, type AgentStore } from "./agents/store.js";
import { ContractError, MemoryStore, type RunStore } from "./persistence/memory.js";
import { loadReferenceAgent } from "./reference-agent.js";
import { resolveAfterFixParent, withRunLinks } from "./harness/replay.js";
import { runTasks, type DriverMode, type InjectionRequest } from "./harness/runner.js";
import { WORLD_BUSY_ERROR, WorldBusyError } from "./harness/world-gate.js";
import { sessionView } from "./harness/session.js";
import { registerFrontendCors } from "./cors.js";
import { isRecord } from "./util.js";
import { registerDiagnosisRoutes, type DiagnosisOptions } from "./diagnosis/routes.js";
import { registerEvalResultsRoutes } from "./eval/routes.js";
import { registerEvalsetRoutes, type EvalsetGenerateOptions } from "./evalset/routes.js";
import { filterTraces, parseTraceListQuery } from "./otel/present.js";
import { registerOtelImportRoutes, type OtelRouteOptions } from "./otel/routes.js";
import { registerTraceImportRoutes } from "./traces/import.js";

export interface BuildAppOptions {
  logger?: boolean;
  store?: RunStore;
  agents?: AgentStore;
  agent?: Agent;
  mockBaseUrl?: string;
  mock?: MockShopClient;
  /**
   * Called after each mock setup while the world gate is held.
   * Tests use it as a barrier. It is not read from the HTTP body.
   */
  afterWorldSetup?: () => void | Promise<void>;
  diagnosis?: DiagnosisOptions;
  evalset?: EvalsetGenerateOptions;
  /** Test double for `POST /agents/:agentId/traces/pull`. Production uses global fetch. */
  otelFetch?: OtelRouteOptions["fetchImpl"];
  /** Clock for the pull cursor. Production uses the current time. */
  now?: () => Date;
  /** Planner flags. Defaults to process.env. Offline demo passes an empty object. */
  agentEnv?: NodeJS.ProcessEnv;
  /** Fetch used to probe agentservice and to post the grok planner. */
  agentFetch?: typeof fetch;
}

/**
 * Harness API. This process is not the mock shop.
 * `POST /runs` loads `agent_id` from the agent store and runs that agent's tasks.
 * `phase: after_fix` with `parent_run_id` copies the parent task and injection
 * plan when those fields are omitted, and each result includes `parent` plus `links`.
 * `phase: injected` with `parent_run_id` requires a baseline parent and copies its task.
 * The jury case still uses the agent passed to `buildApp`.
 * `outcome.verifier` is written by the verifier. `fault.labels` are written by the injector,
 * or by the attacker on the jury case. Runs leave `diagnosis` null; the explicit
 * POST /traces/:traceId/diagnose route calls agentservice with the stored trace
 * (and the task evalset when present) and persists diagnosis only.
 * `POST /runs` and `POST /attacker/jury-case` share one in-process mock-world gate.
 * A second mutating request gets HTTP 409 `world_busy`. GET routes and
 * POST /traces/:traceId/diagnose do not take that gate.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  registerFrontendCors(app);
  if (FEATURES.robotLab) registerRobotRuns(app);
  const store = options.store ?? new MemoryStore();
  const agents = options.agents ?? new MemoryAgentStore();
  const mockBaseUrl = options.mockBaseUrl ?? process.env.MOCK_SHOP_URL ?? "http://127.0.0.1:8787";
  const agent = options.agent ?? loadReferenceAgent();
  const mock = options.mock ?? createHttpMockClient(mockBaseUrl);
  const agentEnv = options.agentEnv ?? process.env;
  const agentFetch = options.agentFetch ?? fetch;

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: "not_found",
      message: `No route ${request.method} ${request.url}`,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof WorldBusyError) {
      return reply.code(409).send({ error: WORLD_BUSY_ERROR, message: error.message });
    }
    request.log.error(error);
    const message = publicErrorMessage(error, "Internal harness error");
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
    agent_store: agents.kind,
    run_store: store.kind,
    grok_forbidden_write_paths: GROK_FORBIDDEN_WRITE_PATHS,
  }));

  registerAgentRoutes(app, agents);
  registerOtelImportRoutes(app, agents, store, { fetchImpl: options.otelFetch, now: options.now });
  registerDiagnosisRoutes(app, store, agents, options.diagnosis);
  registerEvalsetRoutes(app, options.evalset);
  registerEvalResultsRoutes(app, options.evalset);
  // Production Trace import (#192). Isolated from POST /runs and jury-case.
  registerTraceImportRoutes(app, store);

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

  app.get("/runs", async () => {
    const agentsNow = await agents.list();
    return sessionView({
      runs: await store.listRuns(),
      traces: await store.listTraces(),
      agentCount: agentsNow.length,
    });
  });

  app.get<{ Params: { runId: string } }>("/runs/:runId", async (request, reply) => {
    const run = await store.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: "not_found", message: `No run ${request.params.runId}` });
    return run;
  });

  app.get("/traces", async (request, reply) => {
    const parsed = parseTraceListQuery(request.query);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request", message: parsed.message });
    const traces = filterTraces(await store.listTraces(), parsed.value);
    return { traces };
  });

  app.get<{ Params: { traceId: string } }>("/traces/:traceId", async (request, reply) => {
    const trace = await store.getTrace(request.params.traceId);
    if (!trace) {
      return reply.code(404).send({ error: "not_found", message: `No trace ${request.params.traceId}` });
    }
    return trace;
  });

  app.get("/attacker/jury-case", async () => describeJuryCase());

  app.get("/agent-runtimes", async () => {
    const configured = anyPlannerRequested(agentEnv) ? await probeGrokConfigured(agentEnv, agentFetch) : null;
    return runtimeSnapshot(agentEnv, configured);
  });

  app.get<{ Params: { jobId: string } }>("/agent-jobs/:jobId", async (request, reply) => {
    const job = readAgentJob(request.params.jobId);
    if (!job) return reply.code(404).send({ error: "not_found", message: `No agent job ${request.params.jobId}` });
    return job;
  });

  app.post("/attacker/jury-case", async (request, reply) => {
    const parsed = parseJuryRequest(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request", message: parsed.message });
    try {
      const choice = await choosePlanner(agentEnv, agentFetch, "jury", agent);
      const juryOptions = {
        agent,
        store,
        mock,
        mockBaseUrl,
        includeBaseline: parsed.includeBaseline,
        fixKinds: parsed.fixKinds,
        note: parsed.note,
        taskId: parsed.taskId,
        permissions: parsed.permissions,
        parentRunId: parsed.parentRunId,
        promptOverride: parsed.promptOverride,
        afterWorldSetup: options.afterWorldSetup,
        timeoutMs: choice.mode === "grok" ? GROK_RUN_TIMEOUT_MS : undefined,
        runtimeFallback: choice.mode === "no_key" ? ("no_key" as const) : undefined,
        callAgent: choice.mode === "grok" ? grokCallAgent(agentFetch) : undefined,
      };
      if (choice.mode !== "grok") return await runJuryCase(juryOptions);
      const accepted = await acceptWhenGated(GROK_RUN_TIMEOUT_MS, (onAcquired) =>
        runJuryCase({ ...juryOptions, onGateAcquired: onAcquired }),
      );
      return reply.code(202).send({
        status: "accepted",
        ...accepted,
        agent_runtime: AGENT_RUNTIME_LABELS.grok,
      });
    } catch (error) {
      return replyForHarnessFailure(error, reply);
    }
  });

  app.post("/runs", async (request, reply) => {
    const parsed = parseRunRequest(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request", message: parsed.message });
    const registered = await agents.get(parsed.value.agentId);
    if (!registered) {
      return reply.code(404).send({ error: "not_found", message: `No agent ${parsed.value.agentId}` });
    }
    const replay = await resolveAfterFixParent({
      store,
      agentId: parsed.value.agentId,
      phase: parsed.value.phase,
      taskIds: parsed.value.taskIds,
      injection: parsed.value.injection,
      parentRunId: parsed.value.parentRunId,
    });
    if (!replay.ok) return reply.code(400).send({ error: "invalid_request", message: replay.message });
    try {
      const runMockUrl = mockBaseUrlForAgent(registered, mockBaseUrl);
      const runMock = runMockUrl === mockBaseUrl ? mock : createHttpMockClient(runMockUrl);
      // The lab UI omits driver. auto probes /health and POSTs /v1/tasks/run when
      // the runtime answers. A missed probe uses the scripted sequence.
      // generate-dataset passes scripted and does not use this default.
      const driver = parsed.value.driver ?? "auto";
      const taskIds = replay.value?.taskIds ?? parsed.value.taskIds;
      // Clean run, inject fault, and verify fix share LAB_AGENT. FIX_AGENT is the
      // later prompt-patch path, not this shop planner.
      const role: PlannerRole = "lab";
      const choice = await choosePlanner(agentEnv, agentFetch, role, registered);
      const timeoutMs = parsed.value.timeoutMs ?? (choice.mode === "grok" ? harnessTimeout(role) : undefined);
      const runOptions = {
        agent: registered,
        store,
        mock: runMock,
        mockBaseUrl: runMockUrl,
        phase: parsed.value.phase,
        taskIds,
        driver,
        injection: replay.value ? replay.value.injection : parsed.value.injection,
        fixKinds: parsed.value.fixKinds,
        parentRunId: replay.value?.parentRunId ?? parsed.value.parentRunId,
        grantCancel: parsed.value.grantCancel,
        timeoutMs,
        promptOverride: parsed.value.promptOverride,
        afterWorldSetup: options.afterWorldSetup,
        planner: choice.mode === "grok" ? ("grok" as const) : undefined,
        runtimeLine: choice.mode === "no_key" ? agentRuntimeLine(AGENT_RUNTIME_LABELS.noKey) : undefined,
      };
      if (choice.mode !== "grok") {
        const results = await runTasks(runOptions);
        return { results: await withRunLinks(store, results) };
      }
      const accepted = await acceptWhenGated(jobDeadline(role, taskIds?.length ?? 1), (onAcquired) =>
        runTasks({ ...runOptions, onGateAcquired: onAcquired }).then((results) => withRunLinks(store, results)),
      );
      return reply.code(202).send({
        status: "accepted",
        ...accepted,
        agent_runtime: AGENT_RUNTIME_LABELS.grok,
      });
    } catch (error) {
      return replyForHarnessFailure(error, reply);
    }
  });

  return app;
}

type PlannerChoice = { mode: "scripted" | "grok" | "no_key"; label: AgentRuntimeLabel };

async function choosePlanner(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  role: PlannerRole,
  shopAgent: Agent,
): Promise<PlannerChoice> {
  if (!agentUsesShopPlanner(shopAgent) || !flagRequestsGrok(env, plannerFlagForRole(role))) {
    return { mode: "scripted", label: AGENT_RUNTIME_LABELS.scripted };
  }
  const configured = await probeGrokConfigured(env, fetchImpl);
  if (configured === true) return { mode: "grok", label: AGENT_RUNTIME_LABELS.grok };
  if (configured === false) return { mode: "no_key", label: AGENT_RUNTIME_LABELS.noKey };
  return { mode: "scripted", label: AGENT_RUNTIME_LABELS.scripted };
}

const grokProbeCache = new Map<string, { at: number; value: boolean | null }>();

async function probeGrokConfigured(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<boolean | null> {
  const origin = agentServiceOrigin(env);
  if (!origin) return null;
  const cached = grokProbeCache.get(origin);
  if (cached && Date.now() - cached.at < 10_000) return cached.value;
  let value: boolean | null = null;
  try {
    const response = await fetchImpl(`${origin}/health`, { signal: AbortSignal.timeout(300) });
    if (response.ok) {
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body.grok_configured === "boolean") value = body.grok_configured;
    }
  } catch {
    value = null;
  }
  grokProbeCache.set(origin, { at: Date.now(), value });
  return value;
}

function agentServiceOrigin(env: NodeJS.ProcessEnv): string | null {
  const raw = env.AGENTSERVICE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function grokCallAgent(fetchImpl: typeof fetch) {
  return async (baseUrl: string, request: AgentRunRequest) => {
    const url = tasksRunUrl(baseUrl);
    const response = await fetchWithTransientRetry(
      fetchImpl,
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, agent: "grok" }),
        signal: AbortSignal.timeout(GROK_AGENT_HTTP_TIMEOUT_MS),
      },
      { label: `Agent service ${new URL(url).pathname}` },
    );
    if (!response.ok) throw new Error(`Jury Grok agent returned ${response.status}.`);
    return parseAgentResponse(await response.json());
  };
}

function harnessTimeout(role: PlannerRole): number {
  if (role === "attacker") return GROK_ATTACKER_HARNESS_TIMEOUT_MS;
  if (role === "fix") return GROK_FIX_RUN_TIMEOUT_MS;
  return GROK_RUN_TIMEOUT_MS;
}

function jobDeadline(role: PlannerRole, taskCount: number): number {
  const count = Math.max(1, taskCount);
  if (role === "attacker") return GROK_ATTACKER_HARNESS_TIMEOUT_MS;
  if (role === "fix") return count * GROK_FIX_RUN_TIMEOUT_MS;
  return count * GROK_RUN_TIMEOUT_MS;
}

function replyForHarnessFailure(error: unknown, reply: FastifyReply) {
  if (error instanceof WorldBusyError) {
    return reply.code(409).send({ error: WORLD_BUSY_ERROR, message: error.message });
  }
  if (error instanceof ContractError) {
    return reply.code(500).send({ error: "error", message: error.message });
  }
  const message = publicErrorMessage(error, "Bad request");
  return reply.code(400).send({ error: "invalid_request", message });
}

interface RunRequest {
  agentId: string;
  phase: RunPhase;
  taskIds?: string[];
  driver?: DriverMode;
  injection?: InjectionRequest;
  fixKinds?: string[];
  parentRunId?: string | null;
  grantCancel?: boolean;
  timeoutMs?: number;
  /** Optional per-run prompt replacement from POST /runs body.prompt_override. */
  promptOverride?: string;
}

function parseJuryRequest(body: unknown):
  | {
      ok: true;
      includeBaseline: boolean;
      fixKinds?: string[];
      note?: string;
      taskId?: string;
      permissions?: string[];
      parentRunId?: string;
      promptOverride?: string;
    }
  | { ok: false; message: string } {
  if (body === undefined || body === null) return { ok: true, includeBaseline: true };
  if (!isRecord(body)) return { ok: false, message: "Body must be a JSON object." };
  if (body.include_baseline !== undefined && typeof body.include_baseline !== "boolean") {
    return { ok: false, message: "include_baseline must be a boolean." };
  }
  let fixKinds: string[] | undefined;
  if (body.fix_kinds !== undefined) {
    if (!Array.isArray(body.fix_kinds) || body.fix_kinds.some((kind) => typeof kind !== "string")) {
      return { ok: false, message: "fix_kinds must be an array of strings." };
    }
    fixKinds = body.fix_kinds;
  }
  let note: string | undefined;
  if (body.note !== undefined) {
    if (typeof body.note !== "string") return { ok: false, message: "note must be a string." };
    note = body.note;
  }
  let taskId: string | undefined;
  if (body.task_id !== undefined) {
    if (typeof body.task_id !== "string" || body.task_id.trim() === "") {
      return { ok: false, message: "task_id must be a non-empty string." };
    }
    taskId = body.task_id.trim();
  }
  let permissions: string[] | undefined;
  if (body.permissions !== undefined) {
    if (!Array.isArray(body.permissions) || body.permissions.some((entry) => typeof entry !== "string")) {
      return { ok: false, message: "permissions must be an array of strings." };
    }
    permissions = body.permissions;
  }
  let parentRunId: string | undefined;
  if (body.parent_run_id !== undefined) {
    if (typeof body.parent_run_id !== "string" || body.parent_run_id.trim() === "") {
      return { ok: false, message: "parent_run_id must be a non-empty string." };
    }
    parentRunId = body.parent_run_id.trim();
  }
  let promptOverride: string | undefined;
  if (body.prompt_override !== undefined) {
    if (typeof body.prompt_override !== "string" || body.prompt_override.trim() === "") {
      return { ok: false, message: "prompt_override must be a non-empty string." };
    }
    promptOverride = body.prompt_override;
  }
  return {
    ok: true,
    includeBaseline: body.include_baseline === undefined ? true : body.include_baseline,
    fixKinds,
    note,
    taskId,
    permissions,
    parentRunId,
    promptOverride,
  };
}

function parseRunRequest(body: unknown): { ok: true; value: RunRequest } | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: "Body must be a JSON object." };
  if (typeof body.agent_id !== "string" || body.agent_id.trim() === "") {
    return { ok: false, message: "agent_id is required and must be a non-empty string." };
  }

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
    parentRunId = typeof body.parent_run_id === "string" ? body.parent_run_id.trim() : body.parent_run_id;
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

  let promptOverride: string | undefined;
  if (body.prompt_override !== undefined) {
    if (typeof body.prompt_override !== "string" || body.prompt_override.trim() === "") {
      return { ok: false, message: "prompt_override must be a non-empty string." };
    }
    promptOverride = body.prompt_override;
  }

  return {
    ok: true,
    value: {
      agentId: body.agent_id,
      phase,
      taskIds,
      driver,
      injection,
      fixKinds,
      parentRunId,
      grantCancel: typeof body.grant_cancel === "boolean" ? body.grant_cancel : undefined,
      timeoutMs,
      promptOverride,
    },
  };
}
