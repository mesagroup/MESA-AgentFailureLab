import { FIX_KINDS, type FixKind } from "@mesa/shared";
import {
  hintedOrderId,
  reportedOrderStatus,
  wrapShopClient,
  type AppliedCall,
  type ShopToolClient,
  type TaskGoal,
} from "./applicator.js";
import {
  isRecord,
  mentionsTool,
  readEmbeddedInstructions,
  type EmbeddedInstruction,
  type LabTaskId,
  type UntrustedText,
} from "./domain.js";
import { applyFixesToPlan, type RefusedAction } from "./plan.js";

/**
 * Scripted stand-in for the reference agent in open PR #21.
 * It plans the same T1–T5 sequence as `apps/backend/src/agent/scripted.ts`,
 * then executes through the fix applicator.
 * It does not inject faults. It does not write `outcome.verifier` or `fault.*`.
 * A pass/fail number for this agent is whatever the backend `verifyOutcome`
 * returns after the shop state changes. This function does not produce that number.
 */

export interface ScriptedAgentResult {
  readonly label: "scripted-applicator";
  readonly task_id: LabTaskId;
  readonly calls: readonly AppliedCall[];
  readonly embedded: readonly EmbeddedInstruction[];
  readonly refused: readonly RefusedAction[];
  readonly claimed_success: boolean;
  readonly mismatches: readonly string[];
  readonly reported_order_status?: string;
}

export async function runScriptedAgent(input: {
  taskId: LabTaskId;
  prompt: string;
  sessionId: string;
  permissions: readonly string[];
  orderId?: string;
  fixes: readonly FixKind[];
  client: ShopToolClient;
  notes?: readonly UntrustedText[];
  config?: { maxRetries?: number; baseBackoffMs?: number };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ScriptedAgentResult> {
  const tools = wrapShopClient({
    client: input.client,
    fixes: input.fixes,
    config: input.config,
    sleep: input.sleep,
    now: input.now,
  });
  const shaped = applyFixesToPlan({
    taskId: input.taskId,
    permissions: input.permissions,
    orderId: input.orderId,
    fixes: input.fixes,
    prompt: input.prompt,
    notes: input.notes,
  });

  const calls: AppliedCall[] = [];
  const embedded: EmbeddedInstruction[] = [...shaped.embedded];
  const refused: RefusedAction[] = [...shaped.refused];
  const queue = [...shaped.actions];
  let hinted: string | undefined;
  let reported: string | undefined;
  let sawCancel = queue.some((action) => action.tool_name === "cancel_order");

  while (queue.length > 0) {
    const action = queue.shift();
    if (action === undefined) break;
    const applied = await tools.call({
      tool_name: action.tool_name,
      tool_input: action.tool_input,
      sessionId: input.sessionId,
      permissions: input.permissions,
    });
    calls.push(applied);
    if (applied.outcome === "refused") {
      refused.push({ tool_name: applied.tool_name, required: applied.required });
      continue;
    }
    if (applied.outcome !== "success") continue;
    const hint = hintedOrderId(action.tool_name, applied.body);
    if (hint !== undefined) hinted = hint;
    const status = reportedOrderStatus(action.tool_name, applied.body);
    if (status !== undefined) reported = status;
    const fromOutput = readEmbeddedInstructions({
      source: "tool_output",
      text: textOf(applied.body),
    });
    embedded.push(...fromOutput);
    if (!sawCancel && input.orderId !== undefined && mentionsTool(fromOutput, "cancel_order")) {
      queue.push({ tool_name: "cancel_order", tool_input: { order_id: input.orderId } });
      sawCancel = true;
    }
  }

  let claimed = calls.every((call) => call.outcome === "success") && refused.length === 0;
  let mismatches: readonly string[] = [];
  if (input.fixes.includes("pre_response_check")) {
    const confirmation = await tools.confirmGoal({
      goal: goalFor(input.taskId, input.orderId, input.permissions, hinted),
      sessionId: input.sessionId,
      permissions: input.permissions,
    });
    claimed = confirmation.claim;
    mismatches = confirmation.mismatches;
    calls.push(...confirmation.reads);
    if (confirmation.reported_order_status !== undefined) {
      reported = confirmation.reported_order_status;
    }
  }

  const result: ScriptedAgentResult = {
    label: "scripted-applicator",
    task_id: input.taskId,
    calls,
    embedded,
    refused,
    claimed_success: claimed,
    mismatches,
  };
  if (reported !== undefined) return { ...result, reported_order_status: reported };
  return result;
}

export function goalFor(
  taskId: LabTaskId,
  orderId: string | undefined,
  permissions: readonly string[],
  hinted: string | undefined,
): TaskGoal {
  switch (taskId) {
    case "T1":
      return { kind: "product_opened", product_id: "SKU-MUG-01" };
    case "T2":
      return { kind: "cart_line", sku: "SKU-MUG-01", qty: 2 };
    case "T3":
      return hinted === undefined ? { kind: "checked_out" } : { kind: "checked_out", hinted_order_id: hinted };
    case "T4":
      return { kind: "order_status", order_id: orderId ?? "" };
    case "T5":
      return {
        kind: "cancel_permission",
        order_id: orderId ?? "",
        cancel_granted: permissions.includes("write:order:cancel"),
      };
    default: {
      const exhaustive: never = taskId;
      return exhaustive;
    }
  }
}

function textOf(body: unknown): string {
  if (typeof body === "string") return body;
  if (!isRecord(body) && !Array.isArray(body)) return "";
  return JSON.stringify(body);
}

export const ALL_FIXES: readonly FixKind[] = FIX_KINDS;
