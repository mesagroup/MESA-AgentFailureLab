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
/** A stored document plus the first-insert time. That time is not a Run or Trace field. */
export interface StoredDocument<T> {
  created_at: string;
  document: T;
}

export interface RunStore {
  readonly kind: RunStoreKind;
  saveRun(run: Run): Promise<Run>;
  getRun(runId: string): Promise<Run | undefined>;
  /** First-save order, then `run_id`. An update does not move a row. */
  listRuns(): Promise<Run[]>;
  /** Runs for one agent, oldest first save first. */
  listRunsByAgent(agentId: string): Promise<Run[]>;
  /**
   * First-save order with the first-insert time.
   * Postgres reads the `created_at` column. Memory uses the time recorded by
   * `upsertImportedRun`, or an order-preserving stand-in when the harness saved the row.
   */
  listRunRecords(): Promise<Array<StoredDocument<Run>>>;
  saveTrace(trace: Trace): Promise<Trace>;
  getTrace(traceId: string): Promise<Trace | undefined>;
  /** First-save order, then `trace_id`. An update does not move a row. */
  listTraces(): Promise<Trace[]>;
  /** Traces whose `run_id` matches, in first-save order. */
  listTracesByRun(runId: string): Promise<Trace[]>;
  /** Same order as `listTraces`, with the first-insert time. */
  listTraceRecords(): Promise<Array<StoredDocument<Trace>>>;
  /**
   * Insert or replace a run from a backup file.
   * The first insert stores `createdAt`. A later call keeps that time and replaces the document.
   * Not an HTTP route.
   */
  upsertImportedRun(run: Run, createdAt: string): Promise<"inserted" | "updated">;
  /** Insert or replace a trace from a backup file. Keeps the first-insert time. Not an HTTP route. */
  upsertImportedTrace(trace: Trace, createdAt: string): Promise<"inserted" | "updated">;
  /** Delete every run and every trace. Agents are untouched. Not an HTTP route. */
  deleteAllRunsAndTraces(): Promise<{ runs: number; traces: number }>;
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

const ORDER_EPOCH_MS = Date.UTC(2000, 0, 1);

/**
 * UTC timestamp that sorts in `index` order.
 * Used when a source has list order and no `created_at` column (memory, or HTTP).
 * `Date#toISOString` is fixed width, so string order matches time order.
 */
export function orderPreservingTimestamp(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new ContractError("Order timestamp index must be a non-negative integer.");
  }
  return new Date(ORDER_EPOCH_MS + index).toISOString();
}

/** Normalize a backup `created_at` to the UTC form Postgres and `Date#toISOString` share. */
export function assertUtcTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !value.includes("T")) {
    throw new ContractError(`${label} must be a date-time.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ContractError(`${label} is not a valid date-time.`);
  }
  return parsed.toISOString();
}

export function prepareImportedRun(run: Run, createdAt: string): { run: Run; createdAt: string } {
  const valid = assertRun(structuredClone(run));
  return { run: valid, createdAt: assertUtcTimestamp(createdAt, `Run ${valid.run_id} created_at`) };
}

export function prepareImportedTrace(trace: Trace, createdAt: string): { trace: Trace; createdAt: string } {
  const valid = assertTrace(structuredClone(trace));
  return { trace: valid, createdAt: assertUtcTimestamp(createdAt, `Trace ${valid.trace_id} created_at`) };
}
