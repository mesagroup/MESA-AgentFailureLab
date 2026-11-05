import { buildApp as buildHarness, type BuildAppOptions } from "../../backend/src/app.js";
import { MemoryStore } from "../../backend/src/persistence/memory.js";
import { MemoryAgentStore } from "../../backend/src/agents/store.js";
import { buildApp as buildShop } from "../../../services/mock-shop/src/app.js";
import { buildApp as buildService } from "../src/app.js";
import type { Agent, Trace } from "@mesa/shared";
import type { DiagnosisModel } from "../src/diagnosis/diagnose.js";

/** Only loaded by explicit offline mode. Never reads XAI_API_KEY or DATABASE_URL. */
export async function startOfflineShop(
  fixture: Agent,
  modelOverride?: DiagnosisModel | null,
  harness?: Pick<BuildAppOptions, "afterWorldSetup">,
) {
  const shop = buildShop({ logger: false });
  const service = buildService({ logger: false,
    config: { apiKey: null, baseUrl: "http://unused.invalid", modelName: "offline-demo-model", timeoutMs: 1000 },
    model: modelOverride === undefined ? { complete: async request => {
      const view = JSON.parse(request.user) as { steps: Trace["steps"] };
      const step = [...view.steps].reverse().find(step => step.type === "message" && step.role === "assistant");
      if (!step) throw new Error("offline_fixture_missing_step");
      return { content: JSON.stringify({ category: "Verification", cause: "The attempt claimed completion without a confirming product read.",
        step_id: step.step_id, confidence: 0.8, evidence: [`${step.step_id} claims completion without a product result`],
        proposed_fixes: ["pre_response_check"] }), usage: null };
    } } : modelOverride,
  });
  const store = new MemoryStore(), agents = new MemoryAgentStore();
  let backend: ReturnType<typeof buildHarness> | undefined;
  try {
    const mockUrl = await shop.listen({ host: "127.0.0.1", port: 0 });
    const serviceUrl = await service.listen({ host: "127.0.0.1", port: 0 });
    const agent = structuredClone(fixture);
    agent.instance.base_url = serviceUrl;
    agent.test_instance.base_url = serviceUrl;
    backend = buildHarness({
      logger: false, agent, store, agents, mockBaseUrl: mockUrl, diagnosis: { baseUrl: serviceUrl },
      afterWorldSetup: harness?.afterWorldSetup,
      // Flags in the parent shell must not turn this stack onto xAI.
      agentEnv: {},
    });
    const backendUrl = await backend.listen({ host: "127.0.0.1", port: 0 });
    const registration = await fetch(`${backendUrl}/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(agent) });
    if (registration.status !== 201) throw new Error("offline_fixture_registration_failed");
    await registration.json();
    return { backendUrl, agent, store, agents, service, backend,
      close: async () => { await backend?.close(); await service.close(); await shop.close(); } };
  } catch (error) {
    await Promise.allSettled([backend?.close(), service.close(), shop.close()]);
    throw error;
  }
}
