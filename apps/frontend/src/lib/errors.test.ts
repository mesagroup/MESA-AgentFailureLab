import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, apiErrorDetails, friendlyApiMessage } from "./errors.ts";

test("a busy world is described as a run already in progress", () => {
  const error = new ApiError(409, "The mock world is busy.", "world_busy");
  assert.equal(friendlyApiMessage(error), "A run is already in progress. Wait for it to finish, then try again.");
  assert.equal(apiErrorDetails(error), "HTTP 409 world_busy");
});

test("a missing Grok key is described without the raw status", () => {
  const error = new ApiError(503, "grok_not_configured", "grok_not_configured");
  assert.match(friendlyApiMessage(error), /Grok is not configured/);
  assert.equal(apiErrorDetails(error), "HTTP 503 grok_not_configured");
});
