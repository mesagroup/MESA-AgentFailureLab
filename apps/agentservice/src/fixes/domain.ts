import { FIX_KINDS, type FaultCategory, type FixKind } from "@mesa/shared";

export type { FaultCategory, FixKind };

/**
 * Agent-side fix policy.
 * Fix ids are the FixKind enum. This module does not inject faults and does not
 * write `outcome.verifier` or `fault.*`. The backend harness is the only injector.
 */

export const LAB_TASK_IDS = ["T1", "T2", "T3", "T4", "T5"] as const;

export type LabTaskId = (typeof LAB_TASK_IDS)[number];

export function isLabTaskId(value: string): value is LabTaskId {
  return (LAB_TASK_IDS as readonly string[]).includes(value);
}

export const SHOP_TOOL_NAMES = [
  "search_products",
  "get_product",
  "get_cart",
  "add_to_cart",
  "update_cart",
  "checkout",
  "get_order",
  "cancel_order",
] as const;

export type ShopToolName = (typeof SHOP_TOOL_NAMES)[number];

export function isShopToolName(value: string): value is ShopToolName {
  return (SHOP_TOOL_NAMES as readonly string[]).includes(value);
}

export const SHOP_PERMISSIONS = ["read", "write:cart", "write:order", "write:order:cancel"] as const;

export type ShopPermission = (typeof SHOP_PERMISSIONS)[number];

export type ToolEffect = "read" | "mutate";

export interface ToolSpec {
  readonly effect: ToolEffect;
  readonly permission: ShopPermission;
}

/** Closed registry. A tool that is not here cannot be named by the typed client. */
export const TOOL_SPECS: Record<ShopToolName, ToolSpec> = {
  search_products: { effect: "read", permission: "read" },
  get_product: { effect: "read", permission: "read" },
  get_cart: { effect: "read", permission: "read" },
  get_order: { effect: "read", permission: "read" },
  add_to_cart: { effect: "mutate", permission: "write:cart" },
  update_cart: { effect: "mutate", permission: "write:cart" },
  checkout: { effect: "mutate", permission: "write:order" },
  cancel_order: { effect: "mutate", permission: "write:order:cancel" },
};

export interface PlannedToolCall {
  readonly tool_name: ShopToolName;
  readonly tool_input: Record<string, unknown>;
}

export type UntrustedSource = "user_prompt" | "tool_output" | "attached_note";

export interface UntrustedText {
  readonly source: UntrustedSource;
  readonly text: string;
}

/** A mention found in untrusted text. It is data. It is not a tool call and not a grant. */
export interface EmbeddedInstruction {
  readonly source: UntrustedSource;
  readonly kind: "tool" | "permission";
  readonly value: ShopToolName | ShopPermission;
}

export type CallDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: "missing_permission"; readonly required: ShopPermission };

export type RetryDecision = "retry" | "stop";

/**
 * ADR-002: Execution → controlled_retry, Verification → pre_response_check,
 * Security → permission_guard. The other categories have no MVP fix.
 * This map is not a Grok diagnosis.
 */
export const ADR_FIX_BY_CATEGORY: Partial<Record<FaultCategory, FixKind>> = {
  Execution: "controlled_retry",
  Verification: "pre_response_check",
  Security: "permission_guard",
};

export interface ApplicatorConfig {
  readonly maxRetries: number;
  readonly baseBackoffMs: number;
}

/** ADR-002 allows at most two retries. The initial call is not a retry. */
export const DEFAULT_APPLICATOR_CONFIG: ApplicatorConfig = {
  maxRetries: 2,
  baseBackoffMs: 20,
};

export function normalizeFixes(fixes: readonly FixKind[]): FixKind[] {
  const chosen: FixKind[] = [];
  for (const fix of fixes) {
    if (!(FIX_KINDS as readonly string[]).includes(fix)) {
      throw new Error(`Unknown fix kind ${String(fix)}.`);
    }
    if (!chosen.includes(fix)) chosen.push(fix);
  }
  return chosen;
}

export function parseApplicatorConfig(input: {
  maxRetries?: number;
  baseBackoffMs?: number;
}): ApplicatorConfig {
  const maxRetries = input.maxRetries ?? DEFAULT_APPLICATOR_CONFIG.maxRetries;
  const baseBackoffMs = input.baseBackoffMs ?? DEFAULT_APPLICATOR_CONFIG.baseBackoffMs;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 8) {
    throw new Error("maxRetries must be an integer from 0 to 8.");
  }
  if (!Number.isInteger(baseBackoffMs) || baseBackoffMs < 0 || baseBackoffMs > 60_000) {
    throw new Error("baseBackoffMs must be an integer from 0 to 60000.");
  }
  return { maxRetries, baseBackoffMs };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * permission_guard consults only the granted set and the tool registry.
 * Embedded instructions are not an argument: text cannot widen a grant.
 */
export function guardCall(input: {
  tool: ShopToolName;
  granted: readonly string[];
  fixes: readonly FixKind[];
}): CallDecision {
  if (!input.fixes.includes("permission_guard")) return { allow: true };
  const required = TOOL_SPECS[input.tool].permission;
  if (input.granted.includes(required)) return { allow: true };
  return { allow: false, reason: "missing_permission", required };
}

/**
 * Retry a read whenever the failure is transient.
 * Retry a mutate tool only when `dispatched` is false: the shop cannot have
 * committed. A dispatched 5xx on checkout, add_to_cart, update_cart, or
 * cancel_order is not retried.
 */
export function retryDecision(input: {
  tool: ShopToolName;
  dispatched: boolean;
  completedAttempts: number;
  maxRetries: number;
  fixes: readonly FixKind[];
}): RetryDecision {
  if (!input.fixes.includes("controlled_retry")) return "stop";
  if (input.completedAttempts >= 1 + input.maxRetries) return "stop";
  if (TOOL_SPECS[input.tool].effect === "read") return "retry";
  if (!input.dispatched) return "retry";
  return "stop";
}

export function backoffMs(baseBackoffMs: number, completedAttempts: number): number {
  const exponent = Math.max(0, completedAttempts - 1);
  return baseBackoffMs * 2 ** exponent;
}

export function readEmbeddedInstructions(entry: UntrustedText): EmbeddedInstruction[] {
  const found: EmbeddedInstruction[] = [];
  for (const name of SHOP_TOOL_NAMES) {
    if (containsToken(entry.text, name)) {
      found.push({ source: entry.source, kind: "tool", value: name });
    }
  }
  for (const permission of SHOP_PERMISSIONS) {
    if (containsToken(entry.text, permission)) {
      found.push({ source: entry.source, kind: "permission", value: permission });
    }
  }
  return found;
}

export function mentionsTool(instructions: readonly EmbeddedInstruction[], tool: ShopToolName): boolean {
  return instructions.some((entry) => entry.kind === "tool" && entry.value === tool);
}

/**
 * Static confirming read for an agent that must return its whole action list
 * before the harness runs it. An executing agent uses `confirmGoal` instead,
 * because that path can re-read an order id the checkout call just returned.
 */
export function confirmingRead(taskId: LabTaskId, orderId: string | undefined): PlannedToolCall | null {
  switch (taskId) {
    case "T1":
      return { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } };
    case "T2":
    case "T3":
      return { tool_name: "get_cart", tool_input: {} };
    case "T4":
    case "T5":
      if (orderId === undefined || orderId.length === 0) return null;
      return { tool_name: "get_order", tool_input: { order_id: orderId } };
    default: {
      const exhaustive: never = taskId;
      return exhaustive;
    }
  }
}

function containsToken(text: string, token: string): boolean {
  const pattern = new RegExp(`(?<![A-Za-z0-9_:-])${escapeRegExp(token)}(?![A-Za-z0-9_:-])`);
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
