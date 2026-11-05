import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { remapLibrarySchemaB } from "../../../packages/shared/src/otel-library-schema-b.js";
import { validateTrace } from "../../../packages/shared/src/validate.js";
import { buildApp } from "../src/app.js";

const seedDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/shared/examples/otel/library-schema-b",
);

describe("mock library", () => {
  it("renews, returns, and holds only when the copy is out", async () => {
    const app = buildApp();
    try {
      const seeded = await app.inject({
        method: "POST",
        url: "/internal/seed",
        payload: {
          loans: [
            { loan_id: "loan-1042", book_id: "BK-OWL", patron_id: "patron-ada", renewals: 0 },
            { loan_id: "loan-2001", book_id: "BK-RARE", patron_id: "patron-bev", renewals: 0 },
          ],
        },
      });
      assert.equal(seeded.statusCode, 200);

      const denied = await app.inject({ method: "POST", url: "/loans/loan-1042/renew" });
      assert.equal(denied.statusCode, 403);

      const renewed = await app.inject({
        method: "POST",
        url: "/loans/loan-1042/renew",
        headers: { "x-permissions": "write:loan" },
      });
      assert.equal(renewed.statusCode, 200);
      assert.equal(renewed.json().renewals, 1);
      assert.equal(renewed.json().status, "on_loan");

      const returned = await app.inject({
        method: "POST",
        url: "/loans/loan-1042/return",
        headers: { "x-permissions": "write:loan" },
      });
      assert.equal(returned.statusCode, 200);
      assert.equal(returned.json().status, "returned");

      const onShelf = await app.inject({
        method: "POST",
        url: "/holds",
        headers: { "x-permissions": "write:hold" },
        payload: { book_id: "BK-OWL", patron_id: "patron-ada" },
      });
      assert.equal(onShelf.statusCode, 409);

      const held = await app.inject({
        method: "POST",
        url: "/holds",
        headers: { "x-permissions": "write:hold" },
        payload: { book_id: "BK-RARE", patron_id: "patron-ada" },
      });
      assert.equal(held.statusCode, 201);
      const state = await app.inject({ method: "GET", url: "/internal/state" });
      assert.equal(
        state.json().holds.some((hold: { book_id: string; patron_id: string }) => hold.book_id === "BK-RARE" && hold.patron_id === "patron-ada"),
        true,
      );
    } finally {
      await app.close();
    }
  });

  it("serves schema B exports on GET /internal/otel/traces without changing world state", async () => {
    const app = buildApp({ otelSeedDir: seedDir });
    try {
      const before = await app.inject({ method: "GET", url: "/internal/state" });
      const defaulted = await app.inject({ method: "GET", url: "/internal/otel/traces" });
      assert.equal(defaulted.statusCode, 200);
      const prodBody = defaulted.json();
      assert.equal(prodBody.schema_hint, "mesa.otel.library.b");
      assert.equal(prodBody.library_export.channel, "prod");
      assert.equal(prodBody.library_export.task, "renew-loan");
      assert.equal(prodBody.spans.length, 6);

      const explicit = await app.inject({ method: "GET", url: "/internal/otel/traces?source=prod" });
      assert.equal(explicit.statusCode, 200);
      assert.deepEqual(explicit.json(), prodBody);

      const testChannel = await app.inject({ method: "GET", url: "/internal/otel/traces?source=test" });
      assert.equal(testChannel.statusCode, 200);
      assert.equal(testChannel.json().library_export.task, "return-loan");
      assert.equal(testChannel.json().library_export.channel, "test");

      const filtered = await app.inject({
        method: "GET",
        url: "/internal/otel/traces?source=prod&since=2026-11-05T10:00:00.600Z",
      });
      assert.equal(filtered.statusCode, 200);
      assert.equal(filtered.json().spans.length, 2);
      assert.equal(filtered.json().spans[0].lib_span_id, "lib-span-get-result");

      const whole = await app.inject({ method: "GET", url: "/internal/otel/traces?source=prod" });
      assert.equal(whole.json().spans.length, 6);

      const after = await app.inject({ method: "GET", url: "/internal/state" });
      assert.deepEqual(after.json(), before.json());

      const mapped = remapLibrarySchemaB(prodBody, { agentId: "external-library" });
      assert.equal(mapped.ok, true, mapped.ok ? "" : mapped.errors.join("; "));
      if (mapped.ok) assert.equal(validateTrace(mapped.traces[0]).ok, true);
    } finally {
      await app.close();
    }
  });

  it("rejects a bad OTel query or schema header with 400", async () => {
    const app = buildApp({ otelSeedDir: seedDir });
    try {
      const badSource = await app.inject({ method: "GET", url: "/internal/otel/traces?source=shop" });
      assert.equal(badSource.statusCode, 400);
      assert.equal(badSource.json().error, "invalid_request");

      const badSince = await app.inject({ method: "GET", url: "/internal/otel/traces?since=not-a-date" });
      assert.equal(badSince.statusCode, 400);

      const unknown = await app.inject({ method: "GET", url: "/internal/otel/traces?channel=prod" });
      assert.equal(unknown.statusCode, 400);

      const wrongSchema = await app.inject({
        method: "GET",
        url: "/internal/otel/traces",
        headers: { "x-mock-otel-schema": "mesa.otel.shop.a" },
      });
      assert.equal(wrongSchema.statusCode, 400);

      const matching = await app.inject({
        method: "GET",
        url: "/internal/otel/traces",
        headers: { "x-mock-otel-schema": "mesa.otel.library.b" },
      });
      assert.equal(matching.statusCode, 200);
    } finally {
      await app.close();
    }
  });
});
