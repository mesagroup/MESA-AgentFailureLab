import type { Run, Trace } from "@mesa/shared";
import { assertRun, assertTrace, type RunStore } from "./store.js";

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

  async saveTrace(trace: Trace): Promise<Trace> {
    const valid = assertTrace(clone(trace));
    this.traces.set(valid.trace_id, valid);
    return clone(valid);
  }

  async getTrace(traceId: string): Promise<Trace | undefined> {
    const found = this.traces.get(traceId);
    return found ? clone(found) : undefined;
  }

  async listTraces(): Promise<Trace[]> {
    return [...this.traces.values()].map((trace) => clone(trace));
  }

  async listTracesByRun(runId: string): Promise<Trace[]> {
    return [...this.traces.values()].filter((trace) => trace.run_id === runId).map((trace) => clone(trace));
  }

  async close(): Promise<void> {}
}
