import { CONTRACT_VERSION, GROK_FORBIDDEN_WRITE_PATHS } from "@mesa/shared";
import Fastify from "fastify";

/**
 * Reference agent scaffold.
 * This process does not call Grok yet. When it does, it may write Trace.diagnosis only.
 */
export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/", async () => ({
    service: "agentservice",
    message: "MESA Agent Failure Lab agent service scaffold. See GET /health. Grok is not called.",
    contract_version: CONTRACT_VERSION,
  }));

  app.get("/health", async () => ({
    status: "ok",
    service: "agentservice",
    role: "grok-reference-agent",
    grok_configured: Boolean(process.env.XAI_API_KEY),
    contract_version: CONTRACT_VERSION,
    forbidden_write_paths: GROK_FORBIDDEN_WRITE_PATHS,
  }));

  return app;
}
