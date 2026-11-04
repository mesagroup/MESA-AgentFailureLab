import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Agent } from "@mesa/shared";
import { REFERENCE_AGENT_ID } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import { startMockShop } from "./helpers.js";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("POST /runs default driver", { concurrency: false }, () => {
  let shopUrl = "";
  let closeShop: () => Promise<void> = async () => {};

  before(async () => {
    const shop = await startMockShop();
    shopUrl = shop.baseUrl;
    closeShop = shop.close;
  });

  after(async () => {
    await closeShop();
  });

  it("calls POST /v1/tasks/run for reference-shop when the runtime answers", async () => {
    const calls: string[] = [];
    const runtime = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method === "GET" && request.url === "/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (request.method === "POST" && request.url === "/v1/tasks/run") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              executed: false,
              actions: [
                { tool_name: "search_products", tool_input: { q: "mug" } },
                { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
              ],
            }),
          );
          return;
        }
        response.writeHead(404);
        response.end();
      });
    });
    const runtimeUrl = await listen(runtime);
    const app = buildApp({ logger: false, mockBaseUrl: shopUrl });
    try {
      await pointRuntime(app, runtimeUrl);
      const run = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: REFERENCE_AGENT_ID, phase: "baseline", task_ids: ["T1"] },
      });
      assert.equal(run.statusCode, 200);
      const result = run.json().results[0] as { driver: string; run: { status: string } };
      assert.equal(result.driver, "http");
      assert.equal(result.run.status, "passed");
      assert.deepEqual(calls, ["GET /health", "POST /v1/tasks/run"]);
    } finally {
      await app.close();
      await close(runtime);
    }
  });

  it("uses the scripted sequence when the runtime does not answer", async () => {
    const app = buildApp({ logger: false, mockBaseUrl: shopUrl });
    try {
      await pointRuntime(app, "http://127.0.0.1:1");
      const run = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: REFERENCE_AGENT_ID, phase: "baseline", task_ids: ["T1"] },
      });
      assert.equal(run.statusCode, 200);
      const result = run.json().results[0] as { driver: string; run: { status: string } };
      assert.equal(result.driver, "scripted");
      assert.equal(result.run.status, "passed");
    } finally {
      await app.close();
    }
  });

  it("does not call the runtime when driver is scripted", async () => {
    const calls: string[] = [];
    const runtime = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", executed: false, actions: [] }));
    });
    const runtimeUrl = await listen(runtime);
    const app = buildApp({ logger: false, mockBaseUrl: shopUrl });
    try {
      await pointRuntime(app, runtimeUrl);
      const run = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: REFERENCE_AGENT_ID, phase: "baseline", task_ids: ["T1"], driver: "scripted" },
      });
      assert.equal(run.statusCode, 200);
      const result = run.json().results[0] as { driver: string; run: { status: string } };
      assert.equal(result.driver, "scripted");
      assert.equal(result.run.status, "passed");
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
      await close(runtime);
    }
  });
});

async function pointRuntime(app: ReturnType<typeof buildApp>, runtimeUrl: string): Promise<void> {
  const current = await app.inject({ method: "GET", url: `/agents/${REFERENCE_AGENT_ID}` });
  assert.equal(current.statusCode, 200);
  const agent = current.json() as Agent;
  const saved = await app.inject({
    method: "PUT",
    url: `/agents/${REFERENCE_AGENT_ID}`,
    payload: {
      ...agent,
      instance: { ...agent.instance, base_url: runtimeUrl },
      test_instance: { ...agent.test_instance, base_url: runtimeUrl },
    },
  });
  assert.equal(saved.statusCode, 200);
}
