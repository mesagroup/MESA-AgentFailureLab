import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask } from "@mesa/shared";
import {
  checksForDomain,
  deriveTaskDomain,
  domainSetupCopy,
  permissionsForDomain,
} from "./task-domain.ts";

function shopTask(): AgentTask {
  return {
    task_id: "search",
    title: "Search",
    prompt: "Search",
    setup: { cart: [{ sku: "SKU-1", qty: 1 }], orders: [], permissions: ["read"] },
    success_test: {
      type: "verifier_checks",
      checks: [{ name: "catalog_read", description: "catalog" }],
    },
  };
}

function libraryTask(): AgentTask {
  return {
    task_id: "renew-loan",
    title: "Renew",
    prompt: "Renew",
    setup: {
      cart: [],
      orders: [],
      permissions: ["read", "write:loan"],
      library: {
        loans: [{ loan_id: "loan-1", book_id: "BK-1", patron_id: "patron-a", renewals: 0 }],
      },
    },
    success_test: {
      type: "verifier_checks",
      checks: [{ name: "loan_renewed", description: "renewed", params: { loan_id: "loan-1", renewals: 1 } }],
    },
  };
}

test("deriveTaskDomain reads setup and checks, not world.kind", () => {
  assert.equal(deriveTaskDomain([shopTask()]), "shop");
  assert.equal(deriveTaskDomain([libraryTask()]), "library");
  assert.equal(deriveTaskDomain([shopTask(), libraryTask()]), "mixed");
  assert.equal(
    deriveTaskDomain([
      {
        ...shopTask(),
        setup: { cart: [], orders: [], permissions: ["read"] },
        success_test: { type: "verifier_checks", checks: [{ name: "catalog_read", description: "x" }] },
      },
    ]),
    "shop",
  );
});

test("domain filters checks and permissions", () => {
  assert.deepEqual([...checksForDomain("library")], ["loan_renewed", "loan_returned", "hold_placed"]);
  assert.ok(!checksForDomain("shop").includes("loan_renewed"));
  assert.deepEqual([...permissionsForDomain("library")], ["read", "write:loan", "write:hold"]);
  assert.ok(!permissionsForDomain("shop").includes("write:loan"));
  assert.ok(checksForDomain("mixed").includes("loan_renewed"));
  assert.ok(checksForDomain("mixed").includes("catalog_read"));
});

test("setup copy keeps both editors so create can reach library", () => {
  for (const domain of ["shop", "library", "mixed"] as const) {
    const copy = domainSetupCopy(domain);
    assert.equal(copy.setupShop, true);
    assert.equal(copy.setupLibrary, true);
  }
});
