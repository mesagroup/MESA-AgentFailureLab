import { isDeepStrictEqual } from "node:util";
import type { Diagnosis, Run, Trace } from "@mesa/shared";
import {
  assertRun,
  assertTrace,
  orderPreservingTimestamp,
  prepareImportedRun,
  prepareImportedTrace,
  type RunStore,
  type StoredDocument,
} from "./store.js";

export { ContractError } from "./store.js";
export type { RunStore, RunStoreKind } from "./store.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * In-memory Run and Trace store. Records are cloned on the way in and out.
 * A process restart drops every row. There is no seed.
 * Map order is first-save order. Saving an id again does not move it.
 */
export class MemoryStore implements RunStore {
  readonly kind = "memory" as const;
  private readonly runs = new Map<string, Run>();
  private readonly traces = new Map<string, Trace>();
  /** First-insert time for rows that arrived through backup import. Harness saves have none. */
  private readonly runCreatedAt = new Map<string, string>();
  private readonly traceCreatedAt = new Map<string, string>();

  async saveRun(run: Run): Promise<Run> {
    const valid = assertRun(clone(run));
    this.runs.set(valid.run_id, valid);
    return clone(valid);
  }

  async getRun(runId: string): Promise<Run | undefined> {
    const found = this.runs.get(runId);
    return found ? clone(found) : undefined;
  }

  async listRuns(): Promise<Run[]> {
    return [...this.runs.values()].map((run) => clone(run));
  }

  async listRunsByAgent(agentId: string): Promise<Run[]> {
    return [...this.runs.values()].filter((run) => run.agent_id === agentId).map((run) => clone(run));
  }

  async listRunRecords(): Promise<Array<StoredDocument<Run>>> {
    return [...this.runs.entries()].map(([runId, run], index) => ({
      created_at: this.runCreatedAt.get(runId) ?? orderPreservingTimestamp(index),
      document: clone(run),
    }));
  }

  async saveTrace(trace: Trace): Promise<Trace> {
    const valid = assertTrace(clone(trace));
    this.traces.set(valid.trace_id, valid);
    return clone(valid);
  }

  async getTrace(traceId: string): Promise<Trace | undefined> {
    const found = this.traces.get(traceId);
    return found ? clone(found) : undefined;
  }

  async saveDiagnosis(expected: Trace, diagnosis: Diagnosis): Promise<Trace | undefined> {
    const updated = assertTrace(clone({ ...expected, diagnosis }));
    // No await between compare and set: this is atomic in this process.
    if (!isDeepStrictEqual(this.traces.get(expected.trace_id), expected)) return undefined;
    this.traces.set(expected.trace_id, updated);
    return clone(updated);
  }

  async listTraces(): Promise<Trace[]> {
    return [...this.traces.values()].map((trace) => clone(trace));
  }

  async listTracesByRun(runId: string): Promise<Trace[]> {
    return [...this.traces.values()].filter((trace) => trace.run_id === runId).map((trace) => clone(trace));
  }

  async listTraceRecords(): Promise<Array<StoredDocument<Trace>>> {
    return [...this.traces.entries()].map(([traceId, trace], index) => ({
      created_at: this.traceCreatedAt.get(traceId) ?? orderPreservingTimestamp(index),
      document: clone(trace),
    }));
  }

  async upsertImportedRun(run: Run, createdAt: string): Promise<"inserted" | "updated"> {
    const prepared = prepareImportedRun(run, createdAt);
    const existed = this.runs.has(prepared.run.run_id);
    this.runs.set(prepared.run.run_id, prepared.run);
    if (!existed) this.runCreatedAt.set(prepared.run.run_id, prepared.createdAt);
    return existed ? "updated" : "inserted";
  }

  async upsertImportedTrace(trace: Trace, createdAt: string): Promise<"inserted" | "updated"> {
    const prepared = prepareImportedTrace(trace, createdAt);
    const existed = this.traces.has(prepared.trace.trace_id);
    this.traces.set(prepared.trace.trace_id, prepared.trace);
    if (!existed) this.traceCreatedAt.set(prepared.trace.trace_id, prepared.createdAt);
    return existed ? "updated" : "inserted";
  }

  async deleteAllRunsAndTraces(): Promise<{ runs: number; traces: number }> {
    const runs = this.runs.size;
    const traces = this.traces.size;
    this.runs.clear();
    this.traces.clear();
    this.runCreatedAt.clear();
    this.traceCreatedAt.clear();
    return { runs, traces };
  }

  async close(): Promise<void> {}
}
