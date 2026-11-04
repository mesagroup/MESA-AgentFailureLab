/**
 * TypeScript mirror of `schemas/run.schema.json`.
 * Harness metadata. Not a field of Trace.
 * JSON Schema is the source of truth. Update both together and bump CONTRACT_VERSION.
 */

export type RunPhase = "baseline" | "injected" | "after_fix";

export interface Run {
  /** Trace.run_id points at this record. */
  run_id: string;
  phase: RunPhase;
  injection_plan_id?: string;
  /** Harness id of the applied fix. Not written by Grok. */
  fix_id?: string;
  fix_summary?: string;
  fix_applied_at?: string;
  trace_id: string;
}
