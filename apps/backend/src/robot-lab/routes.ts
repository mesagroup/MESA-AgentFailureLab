import { limits, type Scenario, arms, isAction, type Arm, type Decision, type Turn } from "@mesa/shared/robot-lab";
import type { FastifyInstance } from "fastify";
import { parseServiceBaseUrl } from "../agents/endpoints.js";
import { runWarehouse } from "./warehouse.js";

export function registerRobotRuns(app: FastifyInstance) {
  let busy = false;
  app.post<{ Body: { arm: Arm; scenario?: Scenario } }>("/robot-lab/runs", {
    attachValidation: true,
    schema: { body: { type: "object", required: ["arm"], properties: { arm: { enum: arms }, scenario: {
      type: "object", required: ["size", "injections", "obstacles"], properties: {
        size: { type: "integer", enum: [5, 9] }, injections: { type: "integer", minimum: 0, maximum: limits.injections },
        obstacles: { type: "integer", minimum: 0, maximum: limits.obstacles },
      },
    } } } },
  }, async (req, reply) => {
    if (req.validationError) return reply.code(400).send({ message: "Choose a supported robot experiment." });
    if (busy) return reply.code(409).send({ message: "Another robot run is active." });
    const origin = parseServiceBaseUrl(process.env.AGENTSERVICE_URL || "http://127.0.0.1:3002", "AGENTSERVICE_URL");
    const signal = AbortSignal.timeout(90_000);
    async function decide(turn: Turn): Promise<Decision> {
      const { robot, parcel, delivered, scanned } = turn.state;
      const observation = { ...turn, state: { robot, parcel, delivered, scanned } };
      const res = await fetch(origin + "/robot-lab/decision", { method: "POST", signal, redirect: "error",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(observation) });
      if (!res.ok) throw new Error("Agent unavailable");
      const d = await res.json() as Partial<Decision>;
      if (!isAction(d.action) || typeof d.model !== "string") throw new Error("Invalid decision");
      return { action: d.action, model: d.model, tokens: typeof d.tokens === "number" ? d.tokens : null };
    }
    busy = true;
    try { return await runWarehouse(req.body.arm, decide, req.body.scenario); }
    finally { busy = false; }
  });
}
