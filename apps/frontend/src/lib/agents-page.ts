import { isSeededAgentId } from "@mesa/shared";

export function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return /localhost|127\.0\.0\.1|::1/.test(url);
  }
}

/**
 * Demo seeds use the same edit form as an agent someone registered.
 * Name, description, and tasks go through PUT.
 */
export function canEditAgent(agentId: string): boolean {
  return agentId.trim().length > 0;
}

/** `DELETE` of a demo seed is 409. The row stays so the next boot does not have to recreate an edit. */
export function canDeleteAgent(agentId: string): boolean {
  return !isSeededAgentId(agentId);
}

/** After a successful launch, open the first created run. No id → the runs list. */
export function hrefAfterCreateRun(
  results: readonly { run?: { run_id?: string } }[] | null | undefined,
): string {
  const id = results?.[0]?.run?.run_id;
  if (typeof id !== "string" || id.trim().length === 0) return "/runs";
  return `/runs/${encodeURIComponent(id.trim())}`;
}

/** After POST /attacker/jury-case, open the attacked run. Fallback is the security filter. */
export function hrefAfterJuryLaunch(
  report: { attacked?: { run?: { run_id?: string } } } | null | undefined,
): string {
  const href = hrefAfterCreateRun(report?.attacked?.run ? [{ run: report.attacked.run }] : []);
  return href === "/runs" ? "/runs?type=security" : href;
}

export function deleteAgentErrorMessage(error: unknown, agentId: string): string {
  if (isHttpError(error) && error.status === 409) {
    return error.message.trim() || `Agent ${agentId} is a demo seed and cannot be deleted.`;
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Delete failed.";
}

function isHttpError(error: unknown): error is { status: number; message: string } {
  return typeof error === "object"
    && error !== null
    && "status" in error
    && typeof (error as { status: unknown }).status === "number"
    && "message" in error
    && typeof (error as { message: unknown }).message === "string";
}
