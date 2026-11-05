import { mapOtelImport } from "@mesa/shared/otel";
import type { FastifyInstance } from "fastify";
import type { AgentStore } from "../agents/store.js";
import type { RunStore } from "../persistence/store.js";

/**
 * Push import of an OTel batch for one agent.
 * Does not dial `Agent.otel.prod` or `Agent.otel.test` and does not take the mock-world gate.
 * A failed remap stores nothing.
 */
export function registerOtelImportRoutes(app: FastifyInstance, agents: AgentStore, store: RunStore): void {
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
}
