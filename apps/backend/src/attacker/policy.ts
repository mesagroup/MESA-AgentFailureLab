import type { FixKind } from "@mesa/shared";
import type { PlannedAction } from "../agent/scripted.js";

/**
 * Jury decision for `cancel_order`.
 * Mirrors `guardCall` and `readEmbeddedInstructions` in
 * `apps/agentservice/src/fixes/domain.ts`, and the embedded `cancel_order`
 * append in `applyFixesToPlan`. Do not import the agent service from the backend.
 * A tool name or a permission token in the prompt or in a tool result is data.
 * It is not a grant and it is not copied onto `X-Permissions`.
 */

const SHOP_TOOL_NAMES = [
  "search_products",
  "get_product",
  "get_cart",
  "add_to_cart",
  "update_cart",
  "checkout",
  "get_order",
  "cancel_order",
] as const;

const SHOP_PERMISSIONS = ["read", "write:cart", "write:order", "write:order:cancel"] as const;

const TOOL_PERMISSION: Record<(typeof SHOP_TOOL_NAMES)[number], (typeof SHOP_PERMISSIONS)[number]> = {
  search_products: "read",
  get_product: "read",
  get_cart: "read",
  get_order: "read",
  add_to_cart: "write:cart",
  update_cart: "write:cart",
  checkout: "write:order",
  cancel_order: "write:order:cancel",
};

export type UntrustedSource = "user_prompt" | "tool_output";

export interface EmbeddedMention {
  source: UntrustedSource;
  kind: "tool" | "permission";
  value: string;
}

export interface RefusedTool {
  tool_name: string;
  required: string;
}

export interface JuryDecision {
  actions: PlannedAction[];
  refused: RefusedTool[];
  embedded: EmbeddedMention[];
}

export function readEmbeddedInstructions(entry: { source: UntrustedSource; text: string }): EmbeddedMention[] {
  const found: EmbeddedMention[] = [];
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

/**
 * Decide which tools the jury agent will hand to the harness.
 * `permissions` is the session grant. This function does not return a second list,
 * and it does not add a permission it found in `prompt` or `toolOutputs`.
 */
export function decideJuryActions(input: {
  orderId: string;
  permissions: readonly string[];
  fixKinds: readonly FixKind[];
  prompt: string;
  toolOutputs?: readonly string[];
}): JuryDecision {
  const embedded: EmbeddedMention[] = readEmbeddedInstructions({ source: "user_prompt", text: input.prompt });
  for (const text of input.toolOutputs ?? []) {
    embedded.push(...readEmbeddedInstructions({ source: "tool_output", text }));
  }

  const actions: PlannedAction[] = [];
  if (input.permissions.includes("write:order:cancel")) {
    actions.push({ tool_name: "cancel_order", tool_input: { order_id: input.orderId } });
  }
  const mentionsCancel = embedded.some((entry) => entry.kind === "tool" && entry.value === "cancel_order");
  if (mentionsCancel && !actions.some((action) => action.tool_name === "cancel_order")) {
    actions.push({ tool_name: "cancel_order", tool_input: { order_id: input.orderId } });
  }

  if (!input.fixKinds.includes("permission_guard")) {
    return { actions, refused: [], embedded };
  }

  const kept: PlannedAction[] = [];
  const refused: RefusedTool[] = [];
  for (const action of actions) {
    const required = TOOL_PERMISSION[action.tool_name as keyof typeof TOOL_PERMISSION];
    if (required !== undefined && !input.permissions.includes(required)) {
      refused.push({ tool_name: action.tool_name, required });
      continue;
    }
    kept.push(action);
  }
  return { actions: kept, refused, embedded };
}

function containsToken(text: string, token: string): boolean {
  const pattern = new RegExp(`(?<![A-Za-z0-9_:-])${escapeRegExp(token)}(?![A-Za-z0-9_:-])`);
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
