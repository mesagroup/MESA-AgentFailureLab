import { mapOtelImport } from "@mesa/shared/otel";
import type { FastifyInstance } from "fastify";
import type { AgentStore } from "../agents/store.js";
import type { RunStore } from "../persistence/store.js";
import { pullAgentTraces, readOtelPullCursors, type OtelFetch } from "./pull.js";

export interface OtelRouteOptions {
  fetchImpl?: OtelFetch;
  now?: () => Date;
}

/**
 * Push import of an OTel batch for one agent, and pull from `Agent.otel`.
 * Import does not dial `Agent.otel.prod` or `Agent.otel.test`.
 * Pull does. Neither route takes the mock-world gate.
 * A failed import remap stores nothing. A failed pull leaves that source's cursor unchanged.
 */
export function registerOtelImportRoutes(
  app: FastifyInstance,
  agents: AgentStore,
  store: RunStore,
  options: OtelRouteOptions = {},
): void {
  app.post<{ Params: { agentId: string } }>("/agents/:agentId/otel/import", async (request, reply) => {
    const agent = await agents.get(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ error: "not_found", message: `No agent ${request.params.agentId}` });
    }
    const mapped = mapOtelImport(request.body, {
      agentId: agent.agent_id,
      serviceName: agent.otel?.prod.service_name,
    });
    if (!mapped.ok) {
      return reply.code(400).send({
        error: "invalid_otel_import",
        message: mapped.errors.join("; "),
        errors: mapped.errors,
      });
    }
    for (const trace of mapped.traces) {
      const existing = await store.getTrace(trace.trace_id);
      if (existing) {
        return reply.code(409).send({ error: "conflict", message: `Trace ${trace.trace_id} already exists.` });
      }
    }
    for (const run of mapped.runs) {
      const existing = await store.getRun(run.run_id);
      if (existing) {
        return reply.code(409).send({ error: "conflict", message: `Run ${run.run_id} already exists.` });
      }
    }
    const traces = [];
    for (const trace of mapped.traces) traces.push(await store.saveTrace(trace));
    const runs = [];
    for (const run of mapped.runs) runs.push(await store.saveRun(run));
    return reply.code(201).send({ traces, runs });
  });

  app.get<{ Params: { agentId: string } }>("/agents/:agentId/otel/cursors", async (request, reply) => {
    const agent = await agents.get(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ error: "not_found", message: `No agent ${request.params.agentId}` });
    }
    return readOtelPullCursors(store, agent.agent_id);
  });

  app.post<{ Params: { agentId: string } }>("/agents/:agentId/traces/pull", async (request, reply) => {
    const agent = await agents.get(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ error: "not_found", message: `No agent ${request.params.agentId}` });
    }
    const result = await pullAgentTraces({
      agent,
      store,
      body: request.body,
      now: options.now?.(),
      fetchImpl: options.fetchImpl,
    });
    return reply.code(result.status).send(result.body);
  });
}
