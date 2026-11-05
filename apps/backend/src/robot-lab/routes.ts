import { arms, isAction, type Arm, type Decision, type Turn } from "@mesa/shared/robot-lab";
import type { FastifyInstance } from "fastify";
import { parseServiceBaseUrl } from "../agents/endpoints.js";
import { runWarehouse } from "./warehouse.js";

export function registerRobotRuns(app: FastifyInstance) {
  let busy = false;
  app.post<{ Body: { arm: Arm } }>("/robot-lab/runs", {
    attachValidation: true,
    schema: { body: { type: "object", required: ["arm"], properties: { arm: { enum: arms } } } },
  }, async (req, reply) => {
    if (req.validationError) return reply.code(400).send({ message: "Choose a supported robot experiment." });
    if (busy) return reply.code(409).send({ message: "Another robot run is active." });
    const origin = parseServiceBaseUrl(process.env.AGENTSERVICE_URL || "http://127.0.0.1:3002", "AGENTSERVICE_URL");
    const signal = AbortSignal.timeout(90_000);
    async function decide(turn: Turn): Promise<Decision> {
      const res = await fetch(origin + "/robot-lab/decision", { method: "POST", signal, redirect: "error",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(turn) });
      if (!res.ok) throw new Error("Agent unavailable");
      const d = await res.json() as Partial<Decision>;
      if (!isAction(d.action) || typeof d.model !== "string") throw new Error("Invalid decision");
      return { action: d.action, model: d.model, tokens: typeof d.tokens === "number" ? d.tokens : null };
    }
    busy = true;
    try { return await runWarehouse(req.body.arm, decide); }
    finally { busy = false; }
  });
}
