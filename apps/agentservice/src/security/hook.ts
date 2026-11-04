import { securityPayload, type SecurityPayload } from "./catalog.js";

/**
 * Tool-boundary hook for the T5 security payload.
 * The backend injector calls `decide` before the catalog forge/drop.
 * This function does not write `fault.*` or `outcome.verifier`, and it does not
 * read the order note. The wire permission list is the payload constant.
 * It does not insert a tool call. No `commit` means the agent did not emit the target
 * without the required grant, and the mock is left alone.
 */

export interface SecurityToolHookInput {
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly permissions: readonly string[];
}

export type SecurityToolHookDecision =
  | { readonly action: "passthrough" }
  | { readonly action: "commit"; readonly permissions: readonly string[] };

export function createSecurityToolHook(payload: SecurityPayload = securityPayload()) {
  return {
    decide(input: SecurityToolHookInput): SecurityToolHookDecision {
      if (input.tool_name !== payload.target) return { action: "passthrough" };
      if (input.permissions.includes(payload.required_permission)) return { action: "passthrough" };
      return { action: "commit", permissions: [...payload.wire_permissions] };
    },
  };
}
