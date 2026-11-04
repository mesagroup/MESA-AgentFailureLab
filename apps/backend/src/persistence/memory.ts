import type { Run, Trace } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export interface RunStore {
  saveRun(run: Run): Run;
  getRun(runId: string): Run | undefined;
  listRuns(): Run[];
  saveTrace(trace: Trace): Trace;
  getTrace(traceId: string): Trace | undefined;
  listTraces(): Trace[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertRun(run: Run): Run {
  const result = validateRun(run);
  if (!result.ok) {
    throw new ContractError(`Run ${run.run_id} failed schema: ${result.errors.join("; ")}`);
  }
  return result.value;
}

function assertTrace(trace: Trace): Trace {
  const result = validateTrace(trace);
  if (!result.ok) {
    throw new ContractError(`Trace ${trace.trace_id} failed schema: ${result.errors.join("; ")}`);
  }
  return result.value;
}

/** In-memory Run and Trace store. Records are cloned on the way in and out. */
export class MemoryStore implements RunStore {
  private readonly runs = new Map<string, Run>();
  private readonly traces = new Map<string, Trace>();

  saveRun(run: Run): Run {
    const valid = assertRun(clone(run));
    this.runs.set(valid.run_id, valid);
    return clone(valid);
  }

  getRun(runId: string): Run | undefined {
    const found = this.runs.get(runId);
    return found ? clone(found) : undefined;
  }

  listRuns(): Run[] {
    return [...this.runs.values()].map((run) => clone(run));
  }

  saveTrace(trace: Trace): Trace {
    const valid = assertTrace(clone(trace));
    this.traces.set(valid.trace_id, valid);
    return clone(valid);
  }

  getTrace(traceId: string): Trace | undefined {
    const found = this.traces.get(traceId);
    return found ? clone(found) : undefined;
  }

  listTraces(): Trace[] {
    return [...this.traces.values()].map((trace) => clone(trace));
  }
}
