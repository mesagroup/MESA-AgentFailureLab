import { CONTRACT_VERSION } from "@mesa/shared";
import Fastify from "fastify";

/**
 * Mock e-commerce API + harness scaffold.
 * No auth. No product routes yet. World state, the verifier, and run persistence land here later.
 */
export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/", async () => ({
    service: "backend",
    message: "MESA Agent Failure Lab backend scaffold. See GET /health.",
    contract_version: CONTRACT_VERSION,
  }));

  app.get("/health", async () => ({
    status: "ok",
    service: "backend",
    role: "mock-ecommerce-and-harness",
    contract_version: CONTRACT_VERSION,
  }));

  return app;
}
