import { FAULT_CATEGORIES, type InjectionPlan } from "@mesa/shared";

export interface ShopScenario {
  schema_version: 1;
  scenario_id: string;
  agent_file: string;
  task_id: string;
  driver: "http";
  injection_plan: InjectionPlan;
  clean_control_task_ids: string[];
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Only execution data is read. In particular, test_expectations is never copied. */
export function parseShopScenario(value: unknown): ShopScenario {
  if (!record(value) || value.schema_version !== 1 || !nonempty(value.scenario_id) ||
      !nonempty(value.task_id) || value.driver !== "http" || value.planner_endpoint !== "/v1/tasks/run" ||
      value.same_endpoint_for_all_phases !== true || value.dedicated_mock_required !== true ||
      value.serial_execution_required !== true || !nonempty(value.agent_file) ||
      !/^[A-Za-z0-9_-]+\.json$/.test(value.agent_file)) {
    throw new Error("invalid_shop_scenario");
  }
  const plan = value.injection_plan;
  if (!record(plan) || !nonempty(plan.fault) || !nonempty(plan.target) || !record(plan.ground_truth) ||
      !nonempty(plan.ground_truth.code) || !(FAULT_CATEGORIES as readonly unknown[]).includes(plan.ground_truth.category) ||
      plan.ground_truth.step_id !== undefined ||
      (plan.at_step !== undefined && (!Number.isInteger(plan.at_step) || Number(plan.at_step) < 0))) {
    throw new Error("invalid_injection_plan");
  }
  const controls = value.clean_control_task_ids;
  if (!Array.isArray(controls) || controls.length === 0 || !controls.every(nonempty) ||
      new Set(controls).size !== controls.length || !controls.includes(value.task_id)) {
    throw new Error("invalid_clean_controls");
  }
  // Keep the original object shape of supported fields, not any answer-key fields.
  const injectionPlan: InjectionPlan = { fault: plan.fault, target: plan.target,
    ground_truth: { category: plan.ground_truth.category as InjectionPlan["ground_truth"]["category"], code: plan.ground_truth.code },
    ...(plan.at_step !== undefined ? { at_step: Number(plan.at_step) } : {}) };
  return { schema_version: 1, scenario_id: value.scenario_id, agent_file: value.agent_file,
    task_id: value.task_id, driver: "http", injection_plan: injectionPlan, clean_control_task_ids: [...controls] };
}
