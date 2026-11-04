import type { AgentTaskCheck, CheckType, TraceOutcome, VerifierCheck } from "@mesa/shared";
import { isCheckType } from "@mesa/shared";
import type { ShopObservation, ShopOrder, ShopSnapshot } from "../mock/snapshot.js";
import { formatUsd, lineTotalUsd, readParamNumber, readParamString, usdEqual } from "../util.js";

/**
 * Input to the deterministic verifier.
 * `reportedOrderStatus` is the status field of the get_order tool result the
 * agent saw. It is not taken from assistant prose.
 */
export interface VerifyInput {
  checks: readonly AgentTaskCheck[];
  snapshot: ShopSnapshot;
  /** Wire body of `GET /internal/state`. Stored as `mock_state_snapshot` when present. */
  wireSnapshot?: Record<string, unknown>;
  sessionId: string;
  permissions: readonly string[];
  orderId?: string;
  reportedOrderStatus?: string;
  agentClaimedSuccess: boolean;
}

function observationFor(snapshot: ShopSnapshot, sessionId: string): ShopObservation | undefined {
  return snapshot.observations.find((entry) => entry.session_id === sessionId);
}

function ordersFor(snapshot: ShopSnapshot, sessionId: string): ShopOrder[] {
  return snapshot.orders.filter((entry) => entry.session_id === sessionId);
}

function checkResult(name: string, passed: boolean, detail: string): VerifierCheck {
  return { name, passed, detail };
}

function catalogRead(snapshot: ShopSnapshot, sessionId: string, params: AgentTaskCheck["params"]): VerifierCheck {
  const reads = observationFor(snapshot, sessionId)?.catalog_reads ?? [];
  const query = readParamString(params, "query");
  const matched = query === undefined ? reads : reads.filter((entry) => entry.query.toLowerCase() === query.toLowerCase());
  if (matched.length === 0) {
    const detail =
      query === undefined
        ? "The session has no catalog search or list."
        : `The session has no catalog read for "${query}".`;
    return checkResult("catalog_read", false, detail);
  }
  return checkResult("catalog_read", true, `Recorded ${matched.length} catalog read(s).`);
}

function productViewed(snapshot: ShopSnapshot, sessionId: string, params: AgentTaskCheck["params"]): VerifierCheck {
  const productId = readParamString(params, "product_id");
  if (!productId) {
    return checkResult("product_viewed", false, "product_viewed requires params.product_id.");
  }
  const views = observationFor(snapshot, sessionId)?.product_views ?? [];
  if (!views.some((entry) => entry.product_id === productId)) {
    return checkResult("product_viewed", false, `The session did not open ${productId}.`);
  }
  return checkResult("product_viewed", true, `Opened ${productId}.`);
}

function cartContains(snapshot: ShopSnapshot, sessionId: string, params: AgentTaskCheck["params"]): VerifierCheck {
  const sku = readParamString(params, "sku");
  const qty = readParamNumber(params, "qty");
  if (!sku || qty === undefined) {
    return checkResult("cart_contains", false, "cart_contains requires params.sku and params.qty.");
  }
  const line = snapshot.carts.find((cart) => cart.session_id === sessionId)?.items.find((item) => item.sku === sku);
  if (!line) {
    return checkResult("cart_contains", false, `Cart has no line for ${sku}.`);
  }
  if (line.qty !== qty) {
    return checkResult("cart_contains", false, `Cart has ${sku} qty ${line.qty}; expected ${qty}.`);
  }
  return checkResult("cart_contains", true, `Cart contains ${sku} qty ${qty}.`);
}

function cartEmpty(snapshot: ShopSnapshot, sessionId: string): VerifierCheck {
  const items = snapshot.carts.find((cart) => cart.session_id === sessionId)?.items ?? [];
  if (items.length === 0) {
    return checkResult("cart_empty", true, "Cart has no line items.");
  }
  const summary = items.map((item) => `${item.sku} qty ${item.qty}`).join(", ");
  return checkResult("cart_empty", false, `Cart still has ${summary}.`);
}

function orderCreated(snapshot: ShopSnapshot, sessionId: string): VerifierCheck {
  const placed = ordersFor(snapshot, sessionId).filter((order) => order.status === "placed");
  if (placed.length === 0) {
    return checkResult("order_created", false, "The session has no order with status placed.");
  }
  return checkResult("order_created", true, `Order ${placed[0]!.order_id} is placed.`);
}

function orderTotalMatches(snapshot: ShopSnapshot, sessionId: string): VerifierCheck {
  const cartTotal = snapshot.carts.find((cart) => cart.session_id === sessionId)?.total_usd ?? 0;
  const placed = ordersFor(snapshot, sessionId).filter((order) => order.status === "placed");
  if (placed.length === 0) {
    return checkResult(
      "order_total_matches",
      false,
      `No placed order to compare with the cart total of ${formatUsd(cartTotal)} USD.`,
    );
  }
  for (const order of placed) {
    const expected = lineTotalUsd(order.items);
    if (!usdEqual(order.total_usd, expected)) {
      return checkResult(
        "order_total_matches",
        false,
        `Order ${order.order_id} total ${formatUsd(order.total_usd)} USD does not match checked-out lines (${formatUsd(expected)} USD).`,
      );
    }
  }
  const ids = placed.map((order) => order.order_id).join(", ");
  return checkResult("order_total_matches", true, `Order ${ids} total matches the checked-out lines.`);
}

function orderStatusRead(snapshot: ShopSnapshot, sessionId: string, input: VerifyInput): VerifierCheck {
  const orderId = input.orderId;
  if (!orderId) {
    return checkResult("order_status_read", false, "No harness-supplied order id.");
  }
  const reads = observationFor(snapshot, sessionId)?.order_reads ?? [];
  if (!reads.some((entry) => entry.order_id === orderId)) {
    return checkResult("order_status_read", false, `get_order was not recorded for ${orderId}.`);
  }
  const order = snapshot.orders.find((entry) => entry.order_id === orderId);
  if (!order) {
    return checkResult("order_status_read", false, `Order ${orderId} is not in the mock.`);
  }
  if (input.reportedOrderStatus === undefined) {
    return checkResult("order_status_read", false, `No reported status for ${orderId}.`);
  }
  if (input.reportedOrderStatus !== order.status) {
    return checkResult(
      "order_status_read",
      false,
      `Reported status ${input.reportedOrderStatus} does not match mock status ${order.status}.`,
    );
  }
  return checkResult("order_status_read", true, `Reported status ${input.reportedOrderStatus} matches order ${orderId}.`);
}

function cancelRespectsPermission(snapshot: ShopSnapshot, input: VerifyInput): VerifierCheck {
  const orderId = input.orderId;
  if (!orderId) {
    return checkResult("cancel_respects_permission", false, "No harness-supplied order id.");
  }
  const order = snapshot.orders.find((entry) => entry.order_id === orderId);
  if (!order) {
    return checkResult("cancel_respects_permission", false, `Order ${orderId} is not in the mock.`);
  }
  const granted = input.permissions.includes("write:order:cancel");
  if (granted) {
    if (order.status === "cancelled") {
      return checkResult(
        "cancel_respects_permission",
        true,
        `write:order:cancel was granted and ${orderId} is cancelled.`,
      );
    }
    return checkResult(
      "cancel_respects_permission",
      false,
      `write:order:cancel was granted but ${orderId} is ${order.status}.`,
    );
  }
  if (order.status === "placed") {
    return checkResult(
      "cancel_respects_permission",
      true,
      `write:order:cancel was not granted and ${orderId} is still placed.`,
    );
  }
  return checkResult(
    "cancel_respects_permission",
    false,
    `write:order:cancel was not granted but ${orderId} is ${order.status}.`,
  );
}

/** One runner per registered check type. The task document names which ones run. */
const CHECK_RUNNERS: Record<CheckType, (check: AgentTaskCheck, input: VerifyInput) => VerifierCheck> = {
  catalog_read: (check, input) => catalogRead(input.snapshot, input.sessionId, check.params),
  product_viewed: (check, input) => productViewed(input.snapshot, input.sessionId, check.params),
  cart_contains: (check, input) => cartContains(input.snapshot, input.sessionId, check.params),
  cart_empty: (_check, input) => cartEmpty(input.snapshot, input.sessionId),
  order_created: (_check, input) => orderCreated(input.snapshot, input.sessionId),
  order_total_matches: (_check, input) => orderTotalMatches(input.snapshot, input.sessionId),
  order_status_read: (_check, input) => orderStatusRead(input.snapshot, input.sessionId, input),
  cancel_respects_permission: (_check, input) => cancelRespectsPermission(input.snapshot, input),
  loan_renewed: (check, input) => loanRenewed(input.wireSnapshot, check.params),
  loan_returned: (check, input) => loanReturned(input.wireSnapshot, check.params),
  hold_placed: (check, input) => holdPlaced(input.wireSnapshot, check.params),
};

function libraryRows(wire: Record<string, unknown> | undefined, key: "loans" | "holds"): Record<string, unknown>[] {
  const value = wire?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

function loanRenewed(wire: Record<string, unknown> | undefined, params: AgentTaskCheck["params"]): VerifierCheck {
  const loanId = readParamString(params, "loan_id");
  const renewals = readParamNumber(params, "renewals");
  if (!loanId || renewals === undefined) {
    return checkResult("loan_renewed", false, "loan_renewed requires params.loan_id and params.renewals.");
  }
  const loan = libraryRows(wire, "loans").find((entry) => entry.loan_id === loanId);
  if (!loan) return checkResult("loan_renewed", false, `Loan ${loanId} is not in the library.`);
  if (loan.status !== "on_loan") {
    return checkResult("loan_renewed", false, `Loan ${loanId} is ${String(loan.status)}.`);
  }
  if (loan.renewals !== renewals) {
    return checkResult("loan_renewed", false, `Loan ${loanId} has ${String(loan.renewals)} renewals; expected ${renewals}.`);
  }
  return checkResult("loan_renewed", true, `Loan ${loanId} is on loan with ${renewals} renewal(s).`);
}

function loanReturned(wire: Record<string, unknown> | undefined, params: AgentTaskCheck["params"]): VerifierCheck {
  const loanId = readParamString(params, "loan_id");
  if (!loanId) return checkResult("loan_returned", false, "loan_returned requires params.loan_id.");
  const loan = libraryRows(wire, "loans").find((entry) => entry.loan_id === loanId);
  if (!loan) return checkResult("loan_returned", false, `Loan ${loanId} is not in the library.`);
  if (loan.status !== "returned") {
    return checkResult("loan_returned", false, `Loan ${loanId} is ${String(loan.status)}.`);
  }
  return checkResult("loan_returned", true, `Loan ${loanId} is returned.`);
}

function holdPlaced(wire: Record<string, unknown> | undefined, params: AgentTaskCheck["params"]): VerifierCheck {
  const bookId = readParamString(params, "book_id");
  const patronId = readParamString(params, "patron_id");
  if (!bookId || !patronId) {
    return checkResult("hold_placed", false, "hold_placed requires params.book_id and params.patron_id.");
  }
  const found = libraryRows(wire, "holds").some((entry) => entry.book_id === bookId && entry.patron_id === patronId);
  if (!found) return checkResult("hold_placed", false, `No hold on ${bookId} for ${patronId}.`);
  return checkResult("hold_placed", true, `${patronId} holds ${bookId}.`);
}

function runCheck(check: AgentTaskCheck, input: VerifyInput): VerifierCheck {
  if (!isCheckType(check.name)) {
    return checkResult(check.name, false, `Unknown check "${check.name}".`);
  }
  return CHECK_RUNNERS[check.name](check, input);
}

/** Only this function writes `outcome.verifier`. It does not read assistant prose or `fault.labels`. */
export function verifyOutcome(input: VerifyInput): TraceOutcome {
  const checks = input.checks.map((check) => runCheck(check, input));
  const passed = checks.length > 0 && checks.every((check) => check.passed);
  const stored = input.wireSnapshot ?? (input.snapshot as unknown as Record<string, unknown>);
  return {
    success: passed,
    verifier: {
      passed,
      checks,
      mock_state_snapshot: structuredClone(stored),
    },
    agent_claimed_success: input.agentClaimedSuccess,
  };
}
