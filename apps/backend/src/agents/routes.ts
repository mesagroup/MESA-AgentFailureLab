import type { FastifyInstance, FastifyReply } from "fastify";
import {
  AgentConflictError,
  AgentNotFoundError,
  AgentValidationError,
  ProtectedAgentError,
  type AgentStore,
} from "./store.js";

/** Agent CRUD. No auth. The store validates every write. */
export function registerAgentRoutes(app: FastifyInstance, agents: AgentStore): void {
  app.get("/agents", async () => ({ agents: await agents.list() }));

  app.get<{ Params: { agentId: string } }>("/agents/:agentId", async (request, reply) => {
    const agent = await agents.get(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ error: "not_found", message: `No agent ${request.params.agentId}` });
    }
    return agent;
  });

  app.post("/agents", async (request, reply) => {
    try {
      const agent = await agents.create(request.body);
      return reply.code(201).send(agent);
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.put<{ Params: { agentId: string } }>("/agents/:agentId", async (request, reply) => {
    try {
      return await agents.replace(request.params.agentId, request.body);
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.delete<{ Params: { agentId: string } }>("/agents/:agentId", async (request, reply) => {
    try {
      await agents.delete(request.params.agentId);
      return reply.code(204).send();
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });
}

function sendAgentError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AgentValidationError) {
    return reply.code(400).send({
      error: "invalid_agent",
      message: error.message,
      errors: error.errors,
    });
  }
  if (error instanceof AgentNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: error.message });
  }
  if (error instanceof AgentConflictError || error instanceof ProtectedAgentError) {
    return reply.code(409).send({ error: "conflict", message: error.message });
  }
  throw error;
}
