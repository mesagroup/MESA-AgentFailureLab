import {
  CHECK_REGISTRY,
  FIX_KINDS,
  isCheckType,
  type FaultCategory,
  type FixKind,
  type RunPhase,
  type RunStatus,
  type StepRole,
  type StepType,
  type TraceStatus,
} from "@mesa/shared";

export const PRODUCT_NAME = "MESA";
export const PRODUCT_TITLE = "MESA Agent Failure Lab";

export const PHASE_LABEL: Record<RunPhase, string> = {
  baseline: "Baseline",
  injected: "Injected fault",
  after_fix: "After fix",
};

export const PHASE_DESCRIPTION: Record<RunPhase, string> = {
  baseline: "Run the task with no injected fault. The verifier scores the real outcome.",
  injected: "Inject a catalog fault and see whether the agent still claims success.",
  after_fix: "Replay the same fault with a fix applied, then compare the verifier.",
};

export const STATUS_LABEL: Record<RunStatus | TraceStatus, string> = {
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  error: "Error",
  completed: "Completed",
  timeout: "Timed out",
};

export const FIX_LABEL: Record<FixKind, string> = {
  controlled_retry: "Controlled retry",
  pre_response_check: "Check before answering",
  permission_guard: "Permission guard",
};

export const FIX_DESCRIPTION: Record<FixKind, string> = {
  controlled_retry: "Retry a dropped call before the agent answers.",
  pre_response_check: "Re-read the shop before the agent claims success.",
  permission_guard: "Refuse a tool the session was not granted.",
};

export const PERMISSION_LABEL: Record<string, string> = {
  read: "Read catalog and orders",
  "write:cart": "Update the cart",
  "write:order": "Place orders",
  "write:order:cancel": "Cancel orders",
};

export const STEP_TYPE_LABEL: Record<StepType, string> = {
  message: "Message",
  tool_call: "Tool call",
  tool_result: "Tool result",
  system: "System",
};

export const STEP_ROLE_LABEL: Record<StepRole, string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  system: "System",
};

export const KIND_LABEL = {
  reference: "reference",
  external: "external",
} as const;

/** Readable names for catalog and jury fault codes. The raw code stays in a tooltip. */
export const FAULT_CODE_LABEL: Record<string, string> = {
  omitted_required_step: "Omitted a required step",
  forged_tool_result: "Forged tool result",
  stale_tool_result: "Stale tool result",
  wrong_argument: "Wrong argument",
  dropped_tool_call: "Dropped tool call",
  suppressed_readback: "Suppressed read-back",
  forged_permission_success: "Forged permission success",
  unauthorized_cancel_via_juror_note: "Cancel without permission",
};

const PARAM_LABEL: Record<string, string> = {
  query: "Search query",
  product_id: "Product",
  sku: "SKU",
  qty: "Quantity",
};

export function faultCodeLabel(code: string): string {
  return FAULT_CODE_LABEL[code] ?? humanize(code);
}

export function checkLabel(name: string): string {
  if (isCheckType(name)) return CHECK_REGISTRY[name].summary;
  return humanize(name);
}

export function permissionLabel(permission: string): string {
  return PERMISSION_LABEL[permission] ?? humanize(permission);
}

export function paramLabel(name: string): string {
  return PARAM_LABEL[name] ?? humanize(name);
}

export function categoryLabel(category: FaultCategory | string): string {
  return category;
}

export function fixKindsInOrder(): readonly FixKind[] {
  return FIX_KINDS;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Dollar amount a person can read. Zero is $0.00. Sub-cent amounts keep four decimals. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return "$0.00";
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTaskLabel(task: { title?: string | null; task_id?: string | null }): string {
  const title = task.title?.trim();
  if (title) return title;
  return "Untitled task";
}

export function formatRunLabel(input: { taskTitle?: string | null; at?: string | null; sequence?: number }): string {
  const title = input.taskTitle?.trim() || "Untitled task";
  const when = formatDateTime(input.at);
  if (when) return `${when} · ${title}`;
  if (input.sequence && input.sequence > 0) return `Run #${input.sequence} · ${title}`;
  return title;
}

export function formatTraceTitle(input: { taskTitle?: string | null; at?: string | null }): string {
  const title = input.taskTitle?.trim() || "Trace";
  const when = formatDateTime(input.at);
  return when ? `${title} · ${when}` : title;
}

export function checksSummary(checks: readonly { passed: boolean }[]): string {
  const passed = checks.filter((check) => check.passed).length;
  const noun = checks.length === 1 ? "check" : "checks";
  return `${passed}/${checks.length} ${noun}`;
}

function humanize(code: string): string {
  const words = code.replaceAll("_", " ").replaceAll(":", " ").trim();
  if (!words) return code;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
