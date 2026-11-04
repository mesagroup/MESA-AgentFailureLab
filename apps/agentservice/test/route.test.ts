import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { validateTrace } from "@mesa/shared/validate";
import { buildApp } from "../src/app.js";
import type { DiagnosisModel } from "../src/diagnosis/diagnose.js";
import { parseDiagnosisConfig } from "../src/grok/config.js";

before(() => {
  globalThis.fetch = () => Promise.reject(new Error("network disabled"));
});

const config = parseDiagnosisConfig({
  XAI_API_KEY: "",
  GROK_MODEL: "grok-test",
});

describe("POST /diagnose", () => {
  it("returns 400 and does not call the model when the body is not a trace", async () => {
    let calls = 0;
    const model: DiagnosisModel = {
      async complete() {
        calls += 1;
        throw new Error("should not be called");
      },
    };
    await withApp(buildApp({ config, model, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/diagnose",
        payload: { trace_id: "nope" },
      });
      assert.equal(response.statusCode, 400);
      const body: unknown = response.json();
      assert.equal(isRecord(body) && body.error, "invalid_trace");
      assert.ok(isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0);
      assert.equal(calls, 0);
    });
  });

  it("returns the trace with diagnosis filled and the fault still on it", async () => {
    const trace = pendingTrace();
    const model: DiagnosisModel = {
      async complete() {
        return {
          content: JSON.stringify({
            category: "Verification",
            cause: "The agent claimed success from the checkout tool result.",
            step_id: "step-5",
            confidence: 0.8,
            evidence: ["step-5 claims the order was placed."],
            proposed_fixes: ["pre_response_check"],
          }),
          usage: { input_tokens: 3, output_tokens: 4, cost_usd: null },
        };
      },
    };
    await withApp(buildApp({ config, model, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/diagnose",
        payload: trace,
      });
      assert.equal(response.statusCode, 200);
      const body: unknown = response.json();
      const parsed = validateTrace(body);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) {
        return;
      }
      assert.equal(parsed.value.diagnosis?.step_id, "step-5");
      assert.equal(parsed.value.diagnosis?.category, "Verification");
      assert.equal(parsed.value.fault.labels[0]?.code, "forged_tool_result");
      assert.equal(parsed.value.outcome.verifier.passed, false);
      assert.equal(parsed.value.run_id, trace.run_id);
      assert.equal(Object.hasOwn(parsed.value, "usage"), false);
    });
  });

  it("returns 503 when no key and no model are configured", async () => {
    await withApp(buildApp({ config, model: null, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/diagnose",
        payload: pendingTrace(),
      });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: "grok_not_configured" });
    });
  });

  it("returns 502 when the model output is not a diagnosis", async () => {
    const model: DiagnosisModel = {
      async complete() {
        return { content: "not-json", usage: null };
      },
    };
    await withApp(buildApp({ config, model, logger: false }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/diagnose",
        payload: pendingTrace(),
      });
      assert.equal(response.statusCode, 502);
      assert.deepEqual(response.json(), { error: "diagnosis_failed" });
    });
  });

  it("keeps health on the forbidden write paths", async () => {
    await withApp(buildApp({ config, model: null, logger: false }), async (app) => {
      const response = await app.inject({ method: "GET", url: "/health" });
      assert.equal(response.statusCode, 200);
      const body: unknown = response.json();
      assert.equal(isRecord(body) && body.grok_configured, false);
      assert.ok(isRecord(body) && Array.isArray(body.forbidden_write_paths));
      if (!isRecord(body) || !Array.isArray(body.forbidden_write_paths)) {
        return;
      }
      assert.ok(body.forbidden_write_paths.includes("fault.labels"));
      assert.ok(body.forbidden_write_paths.includes("outcome.verifier"));
    });
  });
});

async function withApp(app: FastifyInstance, run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

function pendingTrace(): Record<string, unknown> {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../../../packages/shared/examples/injected-failed-trace.json", import.meta.url), "utf8"),
  );
  if (!isRecord(raw)) {
    throw new Error("fixture was not an object");
  }
  return { ...raw, diagnosis: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
