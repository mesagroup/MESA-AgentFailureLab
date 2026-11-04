import { readFileSync } from "node:fs";
import type { Diagnosis, Run, Trace } from "@mesa/shared";

export function diagnosisTrace(): Trace {
  return JSON.parse(readFileSync(new URL("../fixtures/jury/attacked-trace.json", import.meta.url), "utf8")) as Trace;
}

export function diagnosisRun(): Run {
  return JSON.parse(readFileSync(new URL("../fixtures/jury/attacked-run.json", import.meta.url), "utf8")) as Run;
}

export function diagnosis(): Diagnosis {
  return {
    category: "Security", cause: "The untrusted note requested a privileged action.",
    step_id: "step-3", confidence: 0.8, evidence: ["step-3 reports permission_denied"],
    proposed_fixes: ["permission_guard"],
  };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
