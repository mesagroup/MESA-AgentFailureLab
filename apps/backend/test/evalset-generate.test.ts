import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TASK_EVALSET_VERSION, type AgentTask } from "@mesa/shared";
import { buildApp } from "../src/app.js";

const path = "/evalset/generate";

function sampleTask(): AgentTask {
  return {
    task_id: "search",
    title: "Search and open a product",
    prompt: "Search the catalog and open the matching product page.",
    setup: { cart: [], orders: [], permissions: ["read"] },
    success_test: {
      type: "verifier_checks",
      checks: [{ name: "catalog_read", description: "The session recorded a catalog search." }],
    },
  };
}

const proposed = {
  evalset: {
    version: TASK_EVALSET_VERSION,
    cases: [{ case_id: "claim", expectation: "Cite the catalog search." }],
  },
};

describe("POST /evalset/generate proxy", () => {
  it("forwards the task to agentservice and returns the proposal without storing an agent", async () => {
    let calls = 0;
    const app = buildApp({
      logger: false,
      evalset: {
        baseUrl: "http://agentservice.test/",
        fetchImpl: async (url, init) => {
          calls += 1;
          assert.equal(url, "http://agentservice.test/evalset/generate");
          assert.equal(init?.method, "POST");
          const sent: unknown = JSON.parse(init?.body as string);
          assert.ok(sent && typeof sent === "object");
          return Response.json(proposed);
        },
      },
    });
    try {
      const result = await app.inject({
        method: "POST",
        url: path,
        payload: { mode: "generate", task: sampleTask() },
      });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.json(), proposed);
      assert.equal(calls, 1);
    } finally {
      await app.close();
    }
  });

  it("returns 503 when the upstream is not configured", async () => {
    const app = buildApp({ logger: false, evalset: { baseUrl: null } });
    try {
      const result = await app.inject({
        method: "POST",
        url: path,
        payload: { task: sampleTask() },
      });
      assert.equal(result.statusCode, 503);
      assert.equal(result.json().error, "evalset_not_configured");
    } finally {
      await app.close();
    }
  });

  it("maps grok_not_configured to evalset_unavailable", async () => {
    const app = buildApp({
      logger: false,
      evalset: {
        baseUrl: "http://agentservice.test",
        fetchImpl: async () => new Response("secret key body", { status: 503 }),
      },
    });
    try {
      const result = await app.inject({
        method: "POST",
        url: path,
        payload: { task: sampleTask() },
      });
      assert.equal(result.statusCode, 503);
      assert.equal(result.json().error, "evalset_unavailable");
      assert.doesNotMatch(result.body, /secret/);
    } finally {
      await app.close();
    }
  });

  it("forwards invalid model output errors for the UI", async () => {
    const app = buildApp({
      logger: false,
      evalset: {
        baseUrl: "http://agentservice.test",
        fetchImpl: async () =>
          Response.json(
            { error: "invalid_evalset", errors: ["/cases/0/expectation must NOT have fewer than 1 characters"] },
            { status: 502 },
          ),
      },
    });
    try {
      const result = await app.inject({
        method: "POST",
        url: path,
        payload: { task: sampleTask() },
      });
      assert.equal(result.statusCode, 502);
      assert.equal(result.json().error, "invalid_evalset");
      assert.deepEqual(result.json().errors, ["/cases/0/expectation must NOT have fewer than 1 characters"]);
    } finally {
      await app.close();
    }
  });

  it("times out a hanging upstream", async () => {
    const app = buildApp({
      logger: false,
      evalset: {
        baseUrl: "http://agentservice.test",
        timeoutMs: 20,
        fetchImpl: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      },
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const result = await app.inject({
        method: "POST",
        url: path,
        payload: { task: sampleTask() },
      });
      assert.equal(result.statusCode, 504);
      assert.equal(result.json().error, "evalset_timeout");
    } finally {
      await app.close();
    }
  });
});
