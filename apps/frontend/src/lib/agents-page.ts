import { isSeededAgentId } from "@mesa/shared";

/**
 * Demo seeds use the same edit form as an agent someone registered.
 * Kind does not hide the pencil. Name, description, and tasks go through PUT.
 */
export function canEditAgent(agentId: string): boolean {
  return agentId.trim().length > 0;
}

/** `DELETE` of a demo seed is 409. The row stays so the next boot does not have to recreate an edit. */
export function canDeleteAgent(agentId: string): boolean {
  return !isSeededAgentId(agentId);
}
