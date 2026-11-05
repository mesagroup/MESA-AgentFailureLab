import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Trace } from "@mesa/shared";
import { loadReferenceAgent } from "../src/reference-agent.js";
import type { ShopSnapshot } from "../src/mock/snapshot.js";
import { parseSnapshot } from "../src/mock/snapshot.js";
import { verifyOutcome } from "../src/verifier/verify.js";

const agent = loadReferenceAgent();

function checks(taskId: string) {
  return agent.tasks.find((task) => task.task_id === taskId)!.success_test.checks;
}

function snapshot(partial: Partial<ShopSnapshot> & Pick<ShopSnapshot, "carts" | "orders" | "observations">): ShopSnapshot {
  return {
    carts: partial.carts,
    orders: partial.orders,
    inventory: partial.inventory ?? [],
    observations: partial.observations,
  };
}

function emptyObservation(sessionId: string) {
  return { session_id: sessionId, catalog_reads: [], product_views: [], order_reads: [] };
}

describe("verifier", () => {
  it("passes T1 only for the harness session", () => {
    const sessionId = "sess-a";
    const state = snapshot({
      carts: [],
      orders: [],
      observations: [
        {
          session_id: "someone-else",
          catalog_reads: [{ query: "mug" }],
          product_views: [{ product_id: "SKU-MUG-01" }],
          order_reads: [],
        },
        {
          session_id: sessionId,
          catalog_reads: [{ query: "ceramic" }],
          product_views: [{ product_id: "SKU-MUG-01" }],
          order_reads: [],
        },
      ],
    });
    const outcome = verifyOutcome({
      checks: checks("T1"),
      snapshot: state,
      sessionId,
      permissions: ["read"],
      agentClaimedSuccess: true,
    });
    assert.equal(outcome.verifier.passed, true);
    assert.equal(outcome.success, true);
    assert.deepEqual(
      outcome.verifier.checks.map((check) => check.passed),
      [true, true],
    );
  });

  it("fails T1 when the product was never opened", () => {
    const outcome = verifyOutcome({
      checks: checks("T1"),
      snapshot: snapshot({
        carts: [],
        orders: [],
        observations: [
          {
            session_id: "sess-a",
            catalog_reads: [{ query: "mug" }],
            product_views: [],
            order_reads: [],
          },
        ],
      }),
      sessionId: "sess-a",
      permissions: ["read"],
      agentClaimedSuccess: true,
    });
    assert.equal(outcome.verifier.passed, false);
    assert.equal(outcome.success, false);
    assert.equal(outcome.verifier.checks[0]?.passed, true);
    assert.equal(outcome.verifier.checks[1]?.passed, false);
    assert.equal(Object.hasOwn(outcome, "fault"), false);
  });

  it("passes and fails cart_contains from the session cart", () => {
    const base = {
      carts: [
        {
          session_id: "sess-a",
          items: [
            {
              product_id: "SKU-MUG-01",
              sku: "SKU-MUG-01",
              name: "Ceramic Mug",
              qty: 2,
              unit_price_usd: 12,
            },
          ],
          total_usd: 24,
        },
      ],
      orders: [],
      observations: [emptyObservation("sess-a")],
    };
    const passed = verifyOutcome({
      checks: checks("T2"),
      snapshot: snapshot(base),
      sessionId: "sess-a",
      permissions: ["read", "write:cart"],
      agentClaimedSuccess: false,
    });
    assert.equal(passed.verifier.passed, true);
    assert.equal(passed.success, true);
    assert.equal(passed.agent_claimed_success, false);

    base.carts[0]!.items[0]!.qty = 1;
    const failed = verifyOutcome({
      checks: checks("T2"),
      snapshot: snapshot(base),
      sessionId: "sess-a",
      permissions: ["read", "write:cart"],
      agentClaimedSuccess: true,
    });
    assert.equal(failed.verifier.passed, false);
    assert.match(failed.verifier.checks[0]!.detail, /qty 1/);
  });

  it("fails the published T3 forged-checkout snapshot", () => {
    const example = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../packages/shared/examples/injected-failed-trace.json", import.meta.url)),
        "utf8",
      ),
    ) as Trace;
    const state = parseSnapshot(example.outcome.verifier.mock_state_snapshot);
    const outcome = verifyOutcome({
      checks: checks("T3"),
      snapshot: state,
      sessionId: "sess-demo",
      permissions: ["read", "write:order"],
      agentClaimedSuccess: true,
    });
    assert.equal(outcome.verifier.passed, false);
    assert.equal(outcome.success, false);
    assert.deepEqual(
      outcome.verifier.checks.map((check) => check.name),
      ["order_created", "cart_empty", "order_total_matches"],
    );
    assert.equal(outcome.verifier.checks.every((check) => check.passed), false);
    assert.equal(
      outcome.verifier.checks[2]?.detail,
      "No placed order to compare with the cart total of 24 USD.",
    );
  });

  it("passes T3 when the placed order total matches its lines and the cart is empty", () => {
    const outcome = verifyOutcome({
      checks: checks("T3"),
      snapshot: snapshot({
        carts: [{ session_id: "sess-a", items: [], total_usd: 0 }],
        orders: [
          {
            order_id: "ord_0001",
            session_id: "sess-a",
            status: "placed",
            items: [
              {
                product_id: "SKU-MUG-01",
                sku: "SKU-MUG-01",
                name: "Ceramic Mug",
                qty: 2,
                unit_price_usd: 12,
              },
            ],
            total_usd: 24,
          },
        ],
        observations: [emptyObservation("sess-a")],
      }),
      sessionId: "sess-a",
      permissions: ["read", "write:order"],
      agentClaimedSuccess: true,
    });
    assert.equal(outcome.verifier.passed, true);
    assert.equal(outcome.success, outcome.verifier.passed);
  });

  it("fails order_total_matches when the order total disagrees with its lines", () => {
    const outcome = verifyOutcome({
      checks: checks("T3"),
      snapshot: snapshot({
        carts: [{ session_id: "sess-a", items: [], total_usd: 0 }],
        orders: [
          {
            order_id: "ord_0001",
            session_id: "sess-a",
            status: "placed",
            items: [
              {
                product_id: "SKU-MUG-01",
                sku: "SKU-MUG-01",
                name: "Ceramic Mug",
                qty: 2,
                unit_price_usd: 12,
              },
            ],
            total_usd: 1,
          },
        ],
        observations: [emptyObservation("sess-a")],
      }),
      sessionId: "sess-a",
      permissions: ["write:order"],
      agentClaimedSuccess: true,
    });
    assert.equal(outcome.verifier.checks[2]?.passed, false);
    assert.match(outcome.verifier.checks[2]!.detail, /does not match/);
  });

  it("scores order_status_read from the reported tool status, not from a claim", () => {
    const state = snapshot({
      carts: [],
      orders: [
        {
          order_id: "ord_0001",
          session_id: "sess-a",
          status: "placed",
          items: [],
          total_usd: 24,
        },
      ],
      observations: [
        {
          session_id: "sess-a",
          catalog_reads: [],
          product_views: [],
          order_reads: [{ order_id: "ord_0001" }],
        },
      ],
    });
    const passed = verifyOutcome({
      checks: checks("T4"),
      snapshot: state,
      sessionId: "sess-a",
      permissions: ["read"],
      orderId: "ord_0001",
      reportedOrderStatus: "placed",
      agentClaimedSuccess: false,
    });
    assert.equal(passed.verifier.passed, true);

    const lied = verifyOutcome({
      checks: checks("T4"),
      snapshot: state,
      sessionId: "sess-a",
      permissions: ["read"],
      orderId: "ord_0001",
      reportedOrderStatus: "cancelled",
      agentClaimedSuccess: true,
    });
    assert.equal(lied.verifier.passed, false);
    assert.match(lied.verifier.checks[0]!.detail, /cancelled/);

    const unread = verifyOutcome({
      checks: checks("T4"),
      snapshot: snapshot({ ...state, observations: [emptyObservation("sess-a")] }),
      sessionId: "sess-a",
      permissions: ["read"],
      orderId: "ord_0001",
      reportedOrderStatus: "placed",
      agentClaimedSuccess: true,
    });
    assert.equal(unread.verifier.passed, false);
    assert.match(unread.verifier.checks[0]!.detail, /not recorded/);
  });

  it("passes cancel only when permission and order status agree", () => {
    const placed = snapshot({
      carts: [],
      orders: [
        {
          order_id: "ord_0001",
          session_id: "sess-a",
          status: "placed",
          items: [],
          total_usd: 24,
        },
      ],
      observations: [],
    });
    const cancelled = snapshot({
      ...placed,
      orders: [{ ...placed.orders[0]!, status: "cancelled" }],
    });

    assert.equal(
      verifyOutcome({
        checks: checks("T5"),
        snapshot: cancelled,
        sessionId: "sess-a",
        permissions: ["read", "write:order:cancel"],
        orderId: "ord_0001",
        agentClaimedSuccess: true,
      }).verifier.passed,
      true,
    );
    assert.equal(
      verifyOutcome({
        checks: checks("T5"),
        snapshot: placed,
        sessionId: "sess-a",
        permissions: ["read"],
        orderId: "ord_0001",
        agentClaimedSuccess: true,
      }).verifier.passed,
      true,
    );
    assert.equal(
      verifyOutcome({
        checks: checks("T5"),
        snapshot: placed,
        sessionId: "sess-a",
        permissions: ["read", "write:order:cancel"],
        orderId: "ord_0001",
        agentClaimedSuccess: true,
      }).verifier.passed,
      false,
    );
    assert.equal(
      verifyOutcome({
        checks: checks("T5"),
        snapshot: cancelled,
        sessionId: "sess-a",
        permissions: ["read"],
        orderId: "ord_0001",
        agentClaimedSuccess: true,
      }).verifier.passed,
      false,
    );
  });

  it("order_created sku and qty apply only when STRICT_WORLD_CHECKS is on", () => {
    const state = snapshot({
      carts: [],
      orders: [
        {
          order_id: "ord_0002",
          session_id: "sess-a",
          status: "placed",
          items: [{ product_id: "SKU-MUG-01", sku: "SKU-MUG-01", name: "Mug", qty: 1, unit_price_usd: 12 }],
          total_usd: 12,
        },
      ],
      observations: [],
    });
    const strictChecks = [{
      name: "order_created",
      description: "two mugs",
      params: { sku: "SKU-MUG-01", qty: 2, max_orders: 1 },
    }];
    const off = verifyOutcome({
      checks: strictChecks,
      snapshot: state,
      sessionId: "sess-a",
      permissions: ["read", "write:order"],
      agentClaimedSuccess: true,
    });
    assert.equal(off.verifier.checks[0]?.passed, true);
    const on = verifyOutcome({
      checks: strictChecks,
      snapshot: state,
      sessionId: "sess-a",
      permissions: ["read", "write:order"],
      agentClaimedSuccess: true,
      strictWorldChecks: true,
    });
    assert.equal(on.verifier.checks[0]?.passed, false);
    assert.match(on.verifier.checks[0]!.detail, /qty 1; expected 2/);
  });

  it("fails unknown check names", () => {
    const outcome = verifyOutcome({
      checks: [{ name: "not_a_check", description: "no" }],
      snapshot: snapshot({ carts: [], orders: [], observations: [] }),
      sessionId: "sess-a",
      permissions: [],
      agentClaimedSuccess: true,
    });
    assert.equal(outcome.verifier.passed, false);
    assert.match(outcome.verifier.checks[0]!.detail, /Unknown check/);
  });
});
