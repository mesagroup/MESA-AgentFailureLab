import assert from "node:assert/strict";
import test from "node:test";
import { OTEL_SOURCE_VERSION } from "@mesa/shared";
import { ApiError } from "./errors.ts";
import {
  emptyOtelDraft,
  otelImportErrorText,
  otelSourceErrors,
  otelSourceFromDraft,
  parseOtelBatch,
} from "./otel.ts";

test("a disabled source is omitted and stores no token", () => {
  assert.equal(otelSourceFromDraft(emptyOtelDraft()), undefined);
  const none = otelSourceFromDraft({
    enabled: true,
    endpoint: " https://otel.example.com/v1/traces ",
    authType: "none",
    tokenEnv: "SHOULD_NOT_BE_SENT",
    serviceName: "  ",
  });
  assert.deepEqual(none, {
    version: OTEL_SOURCE_VERSION,
    endpoint: "https://otel.example.com/v1/traces",
    auth: { type: "none" },
  });
  assert.equal(JSON.stringify(none).includes("token"), false);
  assert.equal(JSON.stringify(none).includes("SHOULD_NOT_BE_SENT"), false);
});

test("bearer auth stores the env var name and rejects a pasted token", () => {
  const draft = {
    enabled: true,
    endpoint: "https://otel.example.com/v1/traces",
    authType: "bearer" as const,
    tokenEnv: "OTEL_SOURCE_TOKEN",
    serviceName: "reference-shop",
  };
  assert.deepEqual(otelSourceFromDraft(draft), {
    version: 1,
    endpoint: "https://otel.example.com/v1/traces",
    auth: { type: "bearer", token_env: "OTEL_SOURCE_TOKEN" },
    service_name: "reference-shop",
  });
  const missing = otelSourceErrors({ ...draft, tokenEnv: "" });
  assert.match(missing.token_env ?? "", /Do not paste the token/);
  const secret = otelSourceErrors({ ...draft, tokenEnv: "sk-live-secret" });
  assert.match(secret.token_env ?? "", /OTEL_SOURCE_TOKEN/);
  assert.equal(otelSourceErrors({ ...draft, endpoint: "not a url" }).endpoint?.includes("http"), true);
});

test("a span batch must be JSON, and import errors name 400 and 409", () => {
  assert.equal(parseOtelBatch("  ").ok, false);
  assert.equal(parseOtelBatch("{").ok, false);
  const parsed = parseOtelBatch('{"version":1,"items":[]}');
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { version: 1, items: [] });

  const invalid = otelImportErrorText(
    new ApiError(400, "/items/0/outcome is required", "invalid_otel_import"),
  );
  assert.equal(invalid.message, "/items/0/outcome is required");
  assert.equal(invalid.details, "HTTP 400 invalid_otel_import");

  const duplicate = otelImportErrorText(new ApiError(409, "Trace otel-t1-search already exists.", "conflict"));
  assert.match(duplicate.message, /otel-t1-search/);
  assert.equal(duplicate.details, "HTTP 409 conflict");
});
