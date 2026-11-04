import type { FaultCategory } from "@mesa/shared";

/**
 * Eval set for issue #16.
 * Fixture rows point at traces already on main.
 * Harness rows are produced by `scripts/generate-dataset.ts` with the merged
 * scripted driver, the in-process mock shop, and a catalog fault. That path
 * does not need the reference agent in open PR #21.
 */
export type DatasetPlanEntry =
  | {
      readonly origin: "fixture";
      readonly id: string;
      readonly trace: string;
    }
  | {
      readonly origin: "harness-scripted";
      readonly id: string;
      readonly task_id: "T1" | "T2" | "T3" | "T4" | "T5";
      readonly code: string;
      readonly category: FaultCategory;
      readonly target: string;
    };

export const GENERATED_TRACE_DIR = "apps/agentservice/eval/dataset/generated";
export const MANIFEST_PATH = "apps/agentservice/eval/dataset/manifest.json";
export const RESULTS_DIR = "apps/agentservice/eval/results";

export const DATASET_PLAN = [
  {
    origin: "fixture",
    id: "shared-t3-forged-checkout",
    trace: "packages/shared/examples/injected-failed-trace.json",
  },
  {
    origin: "fixture",
    id: "jury-unauthorized-cancel",
    trace: "apps/backend/fixtures/jury/attacked-trace.json",
  },
  {
    origin: "harness-scripted",
    id: "t1-plan-skip-search",
    task_id: "T1",
    code: "omitted_required_step",
    category: "Plan",
    target: "search_products",
  },
  {
    origin: "harness-scripted",
    id: "t2-plan-skip-add",
    task_id: "T2",
    code: "omitted_required_step",
    category: "Plan",
    target: "add_to_cart",
  },
  {
    origin: "harness-scripted",
    id: "t1-tooluse-forge-search",
    task_id: "T1",
    code: "forged_tool_result",
    category: "ToolUse",
    target: "search_products",
  },
  {
    origin: "harness-scripted",
    id: "t3-tooluse-forge-checkout",
    task_id: "T3",
    code: "forged_tool_result",
    category: "ToolUse",
    target: "checkout",
  },
  {
    origin: "harness-scripted",
    id: "t4-tooluse-forge-order",
    task_id: "T4",
    code: "forged_tool_result",
    category: "ToolUse",
    target: "get_order",
  },
  {
    origin: "harness-scripted",
    id: "t1-context-stale-product",
    task_id: "T1",
    code: "stale_tool_result",
    category: "Context",
    target: "get_product",
  },
  {
    origin: "harness-scripted",
    id: "t2-context-stale-cart",
    task_id: "T2",
    code: "stale_tool_result",
    category: "Context",
    target: "get_cart",
  },
  {
    origin: "harness-scripted",
    id: "t4-context-stale-order",
    task_id: "T4",
    code: "stale_tool_result",
    category: "Context",
    target: "get_order",
  },
  {
    origin: "harness-scripted",
    id: "t1-reasoning-mutate-search",
    task_id: "T1",
    code: "wrong_argument",
    category: "Reasoning",
    target: "search_products",
  },
  {
    origin: "harness-scripted",
    id: "t2-reasoning-mutate-qty",
    task_id: "T2",
    code: "wrong_argument",
    category: "Reasoning",
    target: "add_to_cart",
  },
  {
    origin: "harness-scripted",
    id: "t3-reasoning-mutate-checkout",
    task_id: "T3",
    code: "wrong_argument",
    category: "Reasoning",
    target: "checkout",
  },
  {
    origin: "harness-scripted",
    id: "t1-execution-drop-search",
    task_id: "T1",
    code: "dropped_tool_call",
    category: "Execution",
    target: "search_products",
  },
  {
    origin: "harness-scripted",
    id: "t3-execution-drop-checkout",
    task_id: "T3",
    code: "dropped_tool_call",
    category: "Execution",
    target: "checkout",
  },
  {
    origin: "harness-scripted",
    id: "t4-execution-drop-order",
    task_id: "T4",
    code: "dropped_tool_call",
    category: "Execution",
    target: "get_order",
  },
  {
    origin: "harness-scripted",
    id: "t1-verification-skip-product",
    task_id: "T1",
    code: "suppressed_readback",
    category: "Verification",
    target: "get_product",
  },
  {
    origin: "harness-scripted",
    id: "t3-verification-skip-cart",
    task_id: "T3",
    code: "suppressed_readback",
    category: "Verification",
    target: "get_cart",
  },
  {
    origin: "harness-scripted",
    id: "t5-security-forge-cancel",
    task_id: "T5",
    code: "forged_permission_success",
    category: "Security",
    target: "cancel_order",
  },
] as const satisfies readonly DatasetPlanEntry[];

const ids = DATASET_PLAN.map((entry) => entry.id);
if (new Set(ids).size !== ids.length) {
  throw new Error("DATASET_PLAN has a duplicate id");
}

export function generatedTraceRelativePath(id: string): string {
  return `${GENERATED_TRACE_DIR}/${id}.json`;
}
