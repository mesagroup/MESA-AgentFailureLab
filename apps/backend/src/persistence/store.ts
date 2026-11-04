import type { Run, Trace } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";

export type RunStoreKind = "memory" | "postgres";

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/**
 * Run and Trace store. Writes are validated against the JSON Schemas.
 * The harness is still the only writer of verifier fields. This store does not
 * decide success and it does not call Grok.
 */
export interface RunStore {
  readonly kind: RunStoreKind;
  saveRun(run: Run): Promise<Run>;
  getRun(runId: string): Promise<Run | undefined>;
  /** First-save order, then `run_id`. An update does not move a row. */
  listRuns(): Promise<Run[]>;
  /** Runs for one agent, oldest first save first. */
  listRunsByAgent(agentId: string): Promise<Run[]>;
  saveTrace(trace: Trace): Promise<Trace>;
  getTrace(traceId: string): Promise<Trace | undefined>;
  /** First-save order, then `trace_id`. An update does not move a row. */
  listTraces(): Promise<Trace[]>;
  /** Traces whose `run_id` matches, in first-save order. */
  listTracesByRun(runId: string): Promise<Trace[]>;
  close(): Promise<void>;
}

export function assertRun(run: Run): Run {
  const result = validateRun(run);
  if (!result.ok) {
    throw new ContractError(`Run ${run.run_id} failed schema: ${result.errors.join("; ")}`);
  }
  return result.value;
}

export function assertTrace(trace: Trace): Trace {
  const result = validateTrace(trace);
  if (!result.ok) {
    throw new ContractError(`Trace ${trace.trace_id} failed schema: ${result.errors.join("; ")}`);
  }
  return result.value;
}

export function readStoredRun(value: unknown): Run {
  const result = validateRun(value);
  if (!result.ok) {
    throw new Error(`Stored run failed schema: ${result.errors.join("; ")}`);
  }
  return structuredClone(result.value);
}

export function readStoredTrace(value: unknown): Trace {
  const result = validateTrace(value);
  if (!result.ok) {
    throw new Error(`Stored trace failed schema: ${result.errors.join("; ")}`);
  }
  return structuredClone(result.value);
}
