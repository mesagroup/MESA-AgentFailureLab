import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APIConnectionTimeoutError, APIError } from "openai";
import { FAULT_CATEGORIES, FIX_KINDS } from "@mesa/shared";
import type { ModelCompletionRequest } from "../src/diagnosis/diagnose.js";
import {
  RetryableModelError,
  TerminalModelError,
  buildChatRequest,
  createGrokModel,
  isRetryableProviderError,
  readProviderUsage,
} from "../src/grok/client.js";
import { parseDiagnosisConfig } from "../src/grok/config.js";

const request: ModelCompletionRequest = {
  model: "grok-test",
  system: "system",
  user: "{}",
};

describe("parseDiagnosisConfig", () => {
  it("reads the model from the environment and leaves an empty key unset", () => {
    const config = parseDiagnosisConfig({
      XAI_API_KEY: "  ",
      XAI_BASE_URL: "https://api.x.ai/v1/",
      GROK_MODEL: " grok-4.7 ",
      GROK_TIMEOUT_MS: "15000",
    });
    assert.equal(config.apiKey, null);
    assert.equal(config.baseUrl, "https://api.x.ai/v1");
    assert.equal(config.modelName, "grok-4.7");
    assert.equal(config.timeoutMs, 15_000);
  });

  it("defaults the model and timeout when they are unset", () => {
    const config = parseDiagnosisConfig({});
    assert.equal(config.modelName, "grok-3");
    assert.equal(config.baseUrl, "https://api.x.ai/v1");
    assert.equal(config.timeoutMs, 30_000);
    assert.equal(config.apiKey, null);
  });

  it("rejects a timeout or base URL outside the allowed range", () => {
    assert.throws(() => parseDiagnosisConfig({ GROK_TIMEOUT_MS: "0" }), /GROK_TIMEOUT_MS/);
    assert.throws(() => parseDiagnosisConfig({ XAI_BASE_URL: "file:///tmp/grok" }), /XAI_BASE_URL/);
  });
});

describe("provider usage", () => {
  it("converts cost_in_usd_ticks to dollars and keeps token counts", () => {
    const usage = readProviderUsage({
      prompt_tokens: 199,
      completion_tokens: 1,
      cost_in_usd_ticks: 37_756_000,
    });
    assert.deepEqual(usage, {
      input_tokens: 199,
      output_tokens: 1,
      cost_usd: 0.0037756,
    });
  });

  it("accepts input_tokens and a numeric cost_usd when ticks are absent", () => {
    const usage = readProviderUsage({
      input_tokens: 4,
      output_tokens: 2,
      cost_usd: 0.01,
    });
    assert.deepEqual(usage, { input_tokens: 4, output_tokens: 2, cost_usd: 0.01 });
  });

  it("returns null when token counts are missing", () => {
    assert.equal(readProviderUsage({ cost_in_usd_ticks: 10 }), null);
    assert.equal(readProviderUsage(null), null);
  });
});

describe("chat request", () => {
  it("constrains the completion to the diagnosis field names", () => {
    const body = buildChatRequest(request);
    assert.equal(body.model, "grok-test");
    const format = body.response_format;
    assert.ok(format);
    assert.equal(format.type, "json_schema");
    if (format.type !== "json_schema") {
      return;
    }
    assert.equal(format.json_schema.strict, true);
    const schema = format.json_schema.schema;
    assert.ok(isRecord(schema));
    assert.deepEqual(schema.required, [
      "category",
      "cause",
      "step_id",
      "confidence",
      "evidence",
      "proposed_fixes",
    ]);
    const properties = schema.properties;
    assert.ok(isRecord(properties));
    const category = properties.category;
    const fixes = properties.proposed_fixes;
    assert.ok(isRecord(category));
    assert.ok(isRecord(fixes));
    const fixItems = fixes.items;
    assert.ok(isRecord(fixItems));
    assert.deepEqual(category.enum, [...FAULT_CATEGORIES]);
    assert.deepEqual(fixItems.enum, [...FIX_KINDS]);
    assert.equal(JSON.stringify(body).includes("culprit_step_id"), false);
    assert.equal(JSON.stringify(body).includes("suggested_fix_ids"), false);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("retry", () => {
  it("calls the provider a second time after one retryable failure", async () => {
    let calls = 0;
    const model = createGrokModel({
      apiKey: "test-key",
      baseUrl: "https://api.x.ai/v1",
      timeoutMs: 1000,
      async send() {
        calls += 1;
        if (calls === 1) {
          throw new APIError(503, undefined, "unavailable", undefined);
        }
        return { content: "{}", usage: null };
      },
    });
    const completion = await model.complete(request);
    assert.equal(calls, 2);
    assert.equal(completion.content, "{}");
  });

  it("does not retry a terminal status", async () => {
    let calls = 0;
    const model = createGrokModel({
      apiKey: "test-key",
      baseUrl: "https://api.x.ai/v1",
      timeoutMs: 1000,
      async send() {
        calls += 1;
        throw new APIError(400, undefined, "bad schema", undefined);
      },
    });
    await assert.rejects(() => model.complete(request), (error: unknown) => error instanceof TerminalModelError);
    assert.equal(calls, 1);
  });

  it("stops after the second timeout", async () => {
    let calls = 0;
    const model = createGrokModel({
      apiKey: "test-key",
      baseUrl: "https://api.x.ai/v1",
      timeoutMs: 1000,
      async send() {
        calls += 1;
        throw new APIConnectionTimeoutError({ message: "timed out" });
      },
    });
    await assert.rejects(() => model.complete(request), (error: unknown) => error instanceof RetryableModelError);
    assert.equal(calls, 2);
  });

  it("treats connection timeouts and 429 as retryable and 401 as terminal", () => {
    assert.equal(isRetryableProviderError(new APIConnectionTimeoutError()), true);
    assert.equal(isRetryableProviderError(new APIError(429, undefined, "slow down", undefined)), true);
    assert.equal(isRetryableProviderError(new APIError(401, undefined, "no", undefined)), false);
    assert.equal(isRetryableProviderError(new RetryableModelError()), true);
  });
});
