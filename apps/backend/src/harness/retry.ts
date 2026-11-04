import type { FixKind } from "@mesa/shared";
import { isRecord } from "../util.js";

/**
 * Harness-side retry rule for `executeAttempt`.
 * The decision matches `retryDecision` in `apps/agentservice/src/fixes/domain.ts`:
 * reads retry on a transient result, mutate tools retry only when the attempt
 * was not dispatched, and a dispatched 5xx on a mutate tool stops.
 * This package does not import the agent service.
 * The initial call is not a retry. ADR-002 allows at most two retries.
 */

export const READ_TOOLS = ["search_products", "get_product", "get_cart", "get_order"] as const;

export const MUTATE_TOOLS = ["add_to_cart", "update_cart", "checkout", "cancel_order"] as const;

/** Statuses that count as transient, plus a body whose `error` is `"timeout"`. */
export const TRANSIENT_STATUSES = [0, 408, 429, 500, 502, 503, 504] as const;

export const DEFAULT_MAX_RETRIES = 2;

export const DEFAULT_BASE_BACKOFF_MS = 20;

const TRANSIENT_STATUS_SET = new Set<number>(TRANSIENT_STATUSES);

export type RetryDecision = "retry" | "stop";

export function isReadTool(toolName: string): boolean {
  return (READ_TOOLS as readonly string[]).includes(toolName);
}

export function isMutateTool(toolName: string): boolean {
  return (MUTATE_TOOLS as readonly string[]).includes(toolName);
}

export function isTransientResult(status: number, body: unknown): boolean {
  if (isRecord(body) && body.error === "timeout") return true;
  return TRANSIENT_STATUS_SET.has(status);
}

export function retryDecision(input: {
  tool: string;
  dispatched: boolean;
  completedAttempts: number;
  maxRetries: number;
  fixes: readonly FixKind[];
}): RetryDecision {
  if (!input.fixes.includes("controlled_retry")) return "stop";
  if (input.completedAttempts >= 1 + input.maxRetries) return "stop";
  if (isReadTool(input.tool)) return "retry";
  if (!input.dispatched) return "retry";
  return "stop";
}

/** Exponential backoff. After the first attempt the wait is `base`; then it doubles. */
export function backoffMs(baseBackoffMs: number, completedAttempts: number): number {
  const exponent = Math.max(0, completedAttempts - 1);
  return baseBackoffMs * 2 ** exponent;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
