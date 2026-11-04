import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { TASK_EVALSET_VERSION, type AgentTask } from "@mesa/shared";
import { validateTaskEvalset } from "@mesa/shared/validate";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { DiagnosisModel } from "../src/diagnosis/diagnose.js";
import { RetryableModelError } from "../src/grok/client.js";
import { parseDiagnosisConfig } from "../src/grok/config.js";
import { parseEvalsetGenerateRequest, renderEvalsetPrompt, stubEvalset } from "../src/evalset/generate.js";

before(() => {
  globalThis.fetch = () => Promise.reject(new Error("network disabled"));
});

const config = parseDiagnosisConfig({
  XAI_API_KEY: "",
  GROK_MODEL: "grok-test",
  GROK_TIMEOUT_MS: "50",
});

describe("POST /evalset/generate", () => {
  it("returns a schema-valid proposed evalset without saving an agent", async () => {
    const model: DiagnosisModel = {
      async complete(request) {
        assert.match(request.system, /not judging a Trace or Run now/i);
        assert.match(request.system, /do not replace the deterministic verifier/i);
        assert.equal(request.model, "grok-test");
        return {
          content: JSON.stringify({
            version: 1,
            cases: [
              {
                case_id: "  claim-after-search  ",
                expectation: "The assistant cites the catalog search before claiming it opened the product.",
                rubric: "",
              },
            ],
          }),
          usage: { input_tokens: 9, output_tokens: 4, cost_usd: null },
        };
      },
    };
    await withApp(buildApp({ config, evalsetModel: model, evalsetStub: false, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/evalset/generate",
        payload: { mode: "generate", task: sampleTask() },
      });
      assert.equal(response.statusCode, 200);
      const body: unknown = response.json();
      assert.ok(isRecord(body));
      const parsed = validateTaskEvalset(body.evalset);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      assert.equal(parsed.value.version, TASK_EVALSET_VERSION);
      assert.equal(parsed.value.cases[0]?.case_id, "claim-after-search");
      assert.equal(parsed.value.cases[0]?.rubric, undefined);
      assert.equal(Object.hasOwn(parsed.value.cases[0] ?? {}, "rubric"), false);
    });
  });

  it("returns 502 with schema errors when the model output is not an evalset", async () => {
    const model: DiagnosisModel = {
      async complete() {
        return { content: "not-json", usage: null };
      },
    };
    await withApp(buildApp({ config, evalsetModel: model, evalsetStub: false, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/evalset/generate",
        payload: { task: sampleTask() },
      });
      assert.equal(response.statusCode, 502);
      assert.deepEqual(response.json(), {
        error: "invalid_evalset",
        errors: ["Model output was not a JSON object."],
      });
    });
  });

  it("rejects a model evalset that fails the shared schema", async () => {
    const model: DiagnosisModel = {
      async complete() {
        return {
          content: JSON.stringify({
            version: 1,
            cases: [
              { case_id: "same", expectation: "First reading." },
              { case_id: "same", expectation: "" },
            ],
          }),
          usage: null,
        };
      },
    };
    await withApp(buildApp({ config, evalsetModel: model, evalsetStub: false, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/evalset/generate",
        payload: { task: sampleTask() },
      });
      assert.equal(response.statusCode, 502);
      const body: unknown = response.json();
      assert.ok(isRecord(body));
      assert.equal(body.error, "invalid_evalset");
      assert.ok(Array.isArray(body.errors) && body.errors.length > 0);
    });
  });

  it("returns 503 when no key and no stub are configured", async () => {
    await withApp(buildApp({ config, evalsetModel: null, evalsetStub: false, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/evalset/generate",
        payload: { task: sampleTask() },
      });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: "grok_not_configured" });
    });
  });

  it("returns 504 when the model times out", async () => {
    const model: DiagnosisModel = {
      async complete() {
        return new Promise(() => {
          /* hang until generateEvalset's timeout */
        });
      },
    };
    await withApp(buildApp({ config, evalsetModel: model, evalsetStub: false, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/evalset/generate",
        payload: { task: sampleTask() },
      });
      assert.equal(response.statusCode, 504);
      assert.deepEqual(response.json(), { error: "evalset_timeout" });
    });
  });

  it("maps a retryable provider failure to 504", async () => {
    const model: DiagnosisModel = {
      async complete() {
        throw new RetryableModelError();
      },
    };
    await withApp(buildApp({ config, evalsetModel: model, evalsetStub: false, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/evalset/generate",
        payload: { task: sampleTask() },
      });
      assert.equal(response.statusCode, 504);
      assert.deepEqual(response.json(), { error: "evalset_timeout" });
    });
  });

  it("does not call the model in stub mode and still returns a valid evalset", async () => {
    let calls = 0;
    const model: DiagnosisModel = {
      async complete() {
        calls += 1;
        throw new Error("should not be called");
      },
    };
    await withApp(buildApp({ config, evalsetModel: model, evalsetStub: true, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/evalset/generate",
        payload: { mode: "generate", task: sampleTask() },
      });
      assert.equal(response.statusCode, 200);
      const body: unknown = response.json();
      assert.ok(isRecord(body));
      assert.equal(validateTaskEvalset(body.evalset).ok, true);
      assert.equal(calls, 0);
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.json().evalset_stub, true);
    });
  });

  it("returns 400 for an invalid task and does not call the model", async () => {
    let calls = 0;
    const model: DiagnosisModel = {
      async complete() {
        calls += 1;
        throw new Error("should not be called");
      },
    };
    await withApp(buildApp({ config, evalsetModel: model, evalsetStub: false, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/evalset/generate",
        payload: { task: { task_id: "bare" } },
      });
      assert.equal(response.statusCode, 400);
      const body: unknown = response.json();
      assert.ok(isRecord(body));
      assert.equal(body.error, "invalid_task");
      assert.ok(Array.isArray(body.errors) && body.errors.length > 0);
      assert.equal(calls, 0);
    });
  });
});

describe("evalset generate helpers", () => {
  it("parses generate vs revise and keeps the prompt off the verifier", () => {
    const generate = parseEvalsetGenerateRequest({ mode: "generate", task: sampleTask() });
    assert.equal(generate.ok, true);
    if (!generate.ok) return;
    assert.equal(generate.value.mode, "generate");
    const prompt = renderEvalsetPrompt(generate.value);
    assert.match(prompt.system, /outcome.verifier/);
    assert.match(prompt.user, /Propose a new evalset/);

    const withEval = sampleTask();
    withEval.evalset = {
      version: TASK_EVALSET_VERSION,
      cases: [{ case_id: "keep", expectation: "Cite the search." }],
    };
    const revise = parseEvalsetGenerateRequest({
      mode: "revise",
      instruction: "Keep the case and mention the product page.",
      task: withEval,
    });
    assert.equal(revise.ok, true);
    if (!revise.ok) return;
    assert.equal(revise.value.mode, "revise");
    assert.equal(revise.value.instruction, "Keep the case and mention the product page.");

    const missing = parseEvalsetGenerateRequest({ mode: "revise", task: sampleTask() });
    assert.equal(missing.ok, false);

    const stubbed = stubEvalset({ mode: "generate", task: sampleTask() });
    assert.equal(validateTaskEvalset(stubbed.evalset).ok, true);
  });
});

async function withApp(app: FastifyInstance, run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
