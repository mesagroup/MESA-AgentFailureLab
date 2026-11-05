import Fastify from "fastify";
import { registerRobotDecisions } from "../src/robot-lab/routes.js";
import assert from "node:assert/strict";
import test from "node:test";
import { FEATURES } from "@mesa/shared/robot-lab";
import { buildApp } from "../src/app.js";

test("robot decision URL follows the flag independently of existing task routes", async () => {
  const app = buildApp({ logger: false });
  try {
    assert.equal((await app.inject("/health")).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/robot-lab/decision", payload: {} })).statusCode, FEATURES.robotLab ? 400 : 404);
  } finally { await app.close(); }
});

test("robot SDK boundary sends only the mission and observation, and rejects a fabricated verdict", async () => {
  const provider = Fastify();
  let invalid = false;
  provider.post<{ Body: { messages: { content: string }[]; response_format: { json_schema: { name: string } } } }>(
    "/v1/chat/completions", async req => {
      assert.equal(req.body.response_format.json_schema.name, "RobotAction");
      assert.match(req.body.messages[0]!.content, /work order/);
      const observed = JSON.parse(req.body.messages[1]!.content);
      assert.deepEqual(Object.keys(observed).sort(), ["feedback", "reading", "state"]);
      return { model: "fixture", choices: [{ message: { content: JSON.stringify({ action: invalid ? "declare-success" : "scan" }) } }],
        usage: { total_tokens: 17 } };
    });
  const origin = await provider.listen({ host: "127.0.0.1", port: 0 });
  const agent = Fastify();
  try {
    registerRobotDecisions(agent, { apiKey: "offline-fixture", baseUrl: origin + "/v1", modelName: "fixture", timeoutMs: 3000 });
    const request = { method: "POST" as const, url: "/robot-lab/decision", payload: {
      guarded: true, state: { robot: "A", parcel: "A", scanned: false, delivered: false }, reading: null, feedback: "Mission started.",
    } };
    const valid = await agent.inject(request);
    assert.deepEqual(valid.json(), { action: "scan", model: "fixture", tokens: 17 });
    invalid = true;
    assert.equal((await agent.inject(request)).statusCode, 502);
  } finally { await agent.close(); await provider.close(); }
});
