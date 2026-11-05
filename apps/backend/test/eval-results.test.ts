import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp } from "../src/app.js";

const path = "/eval/results";

const payload = {
  schema_version: 1,
  generated_at: "2026-11-04T14:05:27.488Z",
  dataset: { scored_count: 19, categories: ["Plan"], category_counts: { Plan: 2 } },
  metrics: [{ id: "category_accuracy", label: "Accuratezza di categoria", hits: 4, total: 19, rate: 4 / 19 }],
  report: { schema_version: 1 },
  baseline: { schema_version: 1, metrics: [] },
};

describe("GET /eval/results proxy", () => {
  it("forwards GET to agentservice and returns the scoreboard", async () => {
    let calls = 0;
    const app = buildApp({
      logger: false,
      evalset: {
        baseUrl: "http://agentservice.test/",
        fetchImpl: async (url, init) => {
          calls += 1;
          assert.equal(url, "http://agentservice.test/eval/results");
          assert.equal(init?.method, "GET");
          return Response.json(payload);
        },
      },
    });
    try {
      const result = await app.inject({ method: "GET", url: path });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.json(), payload);
      assert.equal(calls, 1);
    } finally {
      await app.close();
    }
  });

  it("returns 503 when the upstream is not configured", async () => {
    const app = buildApp({ logger: false, evalset: { baseUrl: null } });
    try {
      const result = await app.inject({ method: "GET", url: path });
      assert.equal(result.statusCode, 503);
      assert.equal(result.json().error, "eval_results_not_configured");
    } finally {
      await app.close();
    }
  });

  it("passes through 404 from agentservice", async () => {
    const app = buildApp({
      logger: false,
      evalset: {
        baseUrl: "http://agentservice.test",
        fetchImpl: async () =>
          Response.json(
            { error: "eval_results_not_found", message: "No eval results have been published yet." },
            { status: 404 },
          ),
      },
    });
    try {
      const result = await app.inject({ method: "GET", url: path });
      assert.equal(result.statusCode, 404);
      assert.equal(result.json().error, "eval_results_not_found");
      assert.equal(result.json().message, "No eval results have been published yet.");
    } finally {
      await app.close();
    }
  });

  it("maps a hanging upstream to 504 and a broken payload to 502", async () => {
    const timeoutApp = buildApp({
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
      await timeoutApp.listen({ host: "127.0.0.1", port: 0 });
      const timedOut = await timeoutApp.inject({ method: "GET", url: path });
      assert.equal(timedOut.statusCode, 504);
      assert.equal(timedOut.json().error, "eval_results_timeout");
    } finally {
      await timeoutApp.close();
    }

    const brokenApp = buildApp({
      logger: false,
      evalset: {
        baseUrl: "http://agentservice.test",
        fetchImpl: async () => Response.json({ secret: "do-not-leak" }, { status: 500 }),
      },
    });
    try {
      const result = await brokenApp.inject({ method: "GET", url: path });
      assert.equal(result.statusCode, 502);
      assert.equal(result.json().error, "eval_results_upstream_error");
      assert.doesNotMatch(result.body, /secret/);
    } finally {
      await brokenApp.close();
    }
  });

  it("returns 502 when the upstream body is not a scoreboard", async () => {
    const app = buildApp({
      logger: false,
      evalset: {
        baseUrl: "http://agentservice.test",
        fetchImpl: async () => Response.json({ ok: true }),
      },
    });
    try {
      const result = await app.inject({ method: "GET", url: path });
      assert.equal(result.statusCode, 502);
      assert.equal(result.json().error, "invalid_eval_results_response");
    } finally {
      await app.close();
    }
  });
});
