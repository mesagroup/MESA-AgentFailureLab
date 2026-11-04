import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp } from "../src/app.js";

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
});
