import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Run, Trace } from "@mesa/shared";
import { buildApp } from "../src/app.js";
import { runJuryCase } from "../src/attacker/run-case.js";
import { runTasks, type RunTasksOptions, type TaskRunResult } from "../src/harness/runner.js";
import { prepareWorld } from "../src/harness/world.js";
import {
  WORLD_BUSY_ERROR,
  WORLD_BUSY_MESSAGE,
  WorldBusyError,
  withWorldGate,
} from "../src/harness/world-gate.js";
import { createHttpMockClient, type MockShopClient, type ShopRequest } from "../src/mock/client.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { loadReferenceAgent } from "../src/reference-agent.js";
import { startMockShop } from "./helpers.js";

const reference = loadReferenceAgent();

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function countingClient(inner: MockShopClient): MockShopClient & { resets: number; failRequests: boolean } {
  const client = {
    resets: 0,
    failRequests: false,
    async reset() {
      client.resets += 1;
      return inner.reset();
    },
    state() {
      return inner.state();
    },
    request(options: ShopRequest) {
      if (client.failRequests) throw new Error("execution failed");
      return inner.request(options);
    },
  };
  return client;
}

class SaveFailStore extends MemoryStore {
  traceFailures: number;
  terminalRunFailures: number;

  constructor(traceFailures: number, terminalRunFailures: number) {
    super();
    this.traceFailures = traceFailures;
    this.terminalRunFailures = terminalRunFailures;
  }

  override async saveTrace(trace: Trace): Promise<Trace> {
    if (this.traceFailures > 0) {
      this.traceFailures -= 1;
      throw new Error("trace save failed");
    }
    return super.saveTrace(trace);
  }

  override async saveRun(run: Run): Promise<Run> {
    if (run.status !== "running" && this.terminalRunFailures > 0) {
      this.terminalRunFailures -= 1;
      throw new Error("run save failed");
    }
    return super.saveRun(run);
  }
}

function runOptions(
  baseUrl: string,
  store: MemoryStore,
  mock: MockShopClient,
  extra: Partial<RunTasksOptions> = {},
): RunTasksOptions {
  return {
    agent: reference,
    store,
    mock,
    mockBaseUrl: baseUrl,
    phase: "baseline",
    taskIds: ["T1"],
    ...extra,
  };
}

function assertBusy(error: unknown): boolean {
  assert.ok(error instanceof WorldBusyError);
  assert.equal(error.message, WORLD_BUSY_MESSAGE);
  assert.equal(error.error, WORLD_BUSY_ERROR);
  return true;
}

describe("world gate", () => {
  it("reenters for the same call and rejects a different call", async () => {
    const hold = deferred();
    const inside = deferred();
    let reentered = false;
    const first = withWorldGate(async () => {
      inside.resolve();
      await hold.promise;
      await withWorldGate(async () => {
        reentered = true;
      });
    });
    await inside.promise;
    await assert.rejects(() => withWorldGate(async () => undefined), assertBusy);
    hold.resolve();
    await first;
    assert.equal(reentered, true);
  });

  it("does not reset the shop when the gate is not held", async () => {
    let resets = 0;
    const client: MockShopClient = {
      async reset() {
        resets += 1;
        return { raw: {}, parsed: { carts: [], orders: [], inventory: [], observations: [] } };
      },
      async state() {
        throw new Error("state unused");
      },
      async request() {
        throw new Error("request unused");
      },
    };
    const task = reference.tasks.find((entry) => entry.task_id === "T1");
    assert.ok(task);
    await assert.rejects(() => prepareWorld(task, client, "sess"), /world gate/);
    assert.equal(resets, 0);
  });
});

describe("world gate around runs and jury", { concurrency: false }, () => {
  let baseUrl = "";
  let closeShop: () => Promise<void> = async () => {};

  before(async () => {
    const shop = await startMockShop();
    baseUrl = shop.baseUrl;
    closeShop = shop.close;
  });

  after(async () => {
    await closeShop();
  });

  it("keeps a second run and a jury case from resetting while the first batch is past setup", { timeout: 15_000 }, async () => {
    const mock = countingClient(createHttpMockClient(baseUrl));
    const hold = deferred();
    const ready = deferred();
    let released = false;
    let setups = 0;
    const first = runTasks(
      runOptions(baseUrl, new MemoryStore(), mock, {
        taskIds: ["T1", "T2"],
        afterWorldSetup: async () => {
          setups += 1;
          if (setups !== 1) return;
          ready.resolve();
          await hold.promise;
        },
      }),
    );
    let results: TaskRunResult[] | undefined;
    try {
      await ready.promise;
      assert.equal(mock.resets, 1);
      const second = runTasks(runOptions(baseUrl, new MemoryStore(), mock)).then(
        () => null,
        (error: unknown) => error,
      );
      const jury = runJuryCase({
        agent: reference,
        store: new MemoryStore(),
        mock,
        mockBaseUrl: baseUrl,
        includeBaseline: false,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      const [secondError, juryError] = await Promise.all([second, jury]);
      assertBusy(secondError);
      assertBusy(juryError);
      assert.equal(mock.resets, 1);
      assert.equal(released, false);
    } finally {
      released = true;
      hold.resolve();
      results = await first;
    }
    assert.equal(results?.length, 2);
    assert.equal(results?.[0]?.run.status, "passed");
    assert.equal(results?.[1]?.run.status, "passed");
    assert.equal(mock.resets, 2);
    assert.equal(setups, 2);
  });

  it("releases the gate when execution throws", async () => {
    const mock = countingClient(createHttpMockClient(baseUrl));
    mock.failRequests = true;
    const [failed] = await runTasks(runOptions(baseUrl, new MemoryStore(), mock));
    assert.equal(failed?.run.status, "error");
    assert.match(failed?.run.error_message ?? "", /execution failed/);
    assert.equal(failed?.trace, null);
    mock.failRequests = false;
    const [again] = await runTasks(runOptions(baseUrl, new MemoryStore(), mock));
    assert.equal(again?.run.status, "passed");
    assert.equal(again?.trace?.outcome.verifier.passed, true);
    assert.equal(mock.resets, 2);
  });

  it("releases the gate when the trace save throws", async () => {
    const mock = countingClient(createHttpMockClient(baseUrl));
    const store = new SaveFailStore(1, 0);
    const [failed] = await runTasks(runOptions(baseUrl, store, mock));
    assert.equal(failed?.run.status, "error");
    assert.match(failed?.run.error_message ?? "", /trace save failed/);
    const [again] = await runTasks(runOptions(baseUrl, store, mock));
    assert.equal(again?.run.status, "passed");
    assert.equal(again?.trace?.diagnosis, null);
    assert.equal(mock.resets, 2);
  });

  it("releases the gate when the result save throws out of the runner", async () => {
    const mock = countingClient(createHttpMockClient(baseUrl));
    const store = new SaveFailStore(0, 2);
    await assert.rejects(() => runTasks(runOptions(baseUrl, store, mock)), /run save failed/);
    assert.equal(store.terminalRunFailures, 0);
    const [again] = await runTasks(runOptions(baseUrl, store, mock));
    assert.equal(again?.run.status, "passed");
    assert.equal(again?.trace?.outcome.verifier.passed, true);
    assert.equal(mock.resets, 2);
  });

  it("releases the gate after a harness timeout", async () => {
    const mock = countingClient(createHttpMockClient(baseUrl));
    const [timedOut] = await runTasks(runOptions(baseUrl, new MemoryStore(), mock, { timeoutMs: 0 }));
    assert.equal(timedOut?.trace?.status, "timeout");
    assert.equal(timedOut?.trace?.outcome.success, timedOut?.trace?.outcome.verifier.passed);
    const [again] = await runTasks(runOptions(baseUrl, new MemoryStore(), mock));
    assert.equal(again?.run.status, "passed");
    assert.equal(mock.resets, 2);
  });

  it("lets the jury case call the runner without a nested deadlock", { timeout: 20_000 }, async () => {
    const mock = countingClient(createHttpMockClient(baseUrl));
    let setups = 0;
    let nestedStatus = "";
    const report = await runJuryCase({
      agent: reference,
      store: new MemoryStore(),
      mock,
      mockBaseUrl: baseUrl,
      includeBaseline: true,
      afterWorldSetup: async () => {
        setups += 1;
        if (setups !== 2) return;
        const [nested] = await runTasks(runOptions(baseUrl, new MemoryStore(), mock));
        nestedStatus = nested?.run.status ?? "";
      },
    });
    assert.ok(setups >= 2);
    assert.equal(nestedStatus, "passed");
    assert.ok(report.baseline);
    assert.equal(report.baseline?.trace.outcome.verifier.passed, true);
    assert.equal(report.baseline?.trace.diagnosis, null);
    assert.equal(report.attacked.trace.diagnosis, null);
    assert.equal(typeof report.attacked.trace.outcome.verifier.passed, "boolean");
    assert.ok(report.attacked.trace.outcome.verifier.checks.length > 0);
    assert.equal(report.attacked.trace.fault.attacker.used, true);
  });

  it("returns 409 for a second writer and keeps GETs readable", { timeout: 15_000 }, async () => {
    const store = new MemoryStore();
    const mock = countingClient(createHttpMockClient(baseUrl));
    const hold = deferred();
    const ready = deferred();
    let holding = false;
    const app = buildApp({
      logger: false,
      store,
      mock,
      afterWorldSetup: async () => {
        if (holding) return;
        holding = true;
        ready.resolve();
        await hold.promise;
      },
    });
    const first = app.inject({
      method: "POST",
      url: "/runs",
      payload: { agent_id: "reference-shop", phase: "baseline", task_ids: ["T1"] },
    });
    try {
      await ready.promise;
      assert.equal(mock.resets, 1);

      const second = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: "reference-shop", phase: "baseline", task_ids: ["T2"] },
      });
      assert.equal(second.statusCode, 409);
      assert.deepEqual(second.json(), { error: WORLD_BUSY_ERROR, message: WORLD_BUSY_MESSAGE });
      assert.equal(Object.hasOwn(second.json(), "outcome"), false);

      const jury = await app.inject({
        method: "POST",
        url: "/attacker/jury-case",
        payload: { include_baseline: false },
      });
      assert.equal(jury.statusCode, 409);
      assert.equal(jury.json().error, WORLD_BUSY_ERROR);
      assert.equal(jury.json().message, WORLD_BUSY_MESSAGE);
      assert.equal(mock.resets, 1);

      const bad = await app.inject({ method: "POST", url: "/runs", payload: {} });
      assert.equal(bad.statusCode, 400);
      assert.equal(bad.json().error, "invalid_request");
      const missingAgent = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: "missing-agent", task_ids: ["T1"] },
      });
      assert.equal(missingAgent.statusCode, 404);
      assert.equal(mock.resets, 1);

      for (const url of [
        "/health",
        "/agents",
        "/agents/reference-shop",
        "/runs",
        "/traces",
        "/faults",
        "/attacker/jury-case",
      ]) {
        const response = await app.inject({ method: "GET", url });
        assert.equal(response.statusCode, 200, url);
      }
      const running = (await store.listRuns()).find((run) => run.status === "running");
      assert.ok(running);
      const one = await app.inject({ method: "GET", url: `/runs/${running.run_id}` });
      assert.equal(one.statusCode, 200);
      assert.equal(one.json().status, "running");
      const missingTrace = await app.inject({ method: "GET", url: "/traces/trace-not-saved" });
      assert.equal(missingTrace.statusCode, 404);
      const diagnose = await app.inject({
        method: "POST",
        url: "/traces/trace-not-saved/diagnose",
        payload: {},
      });
      assert.equal(diagnose.statusCode, 404);
      assert.equal(diagnose.json().error, "not_found");
      assert.equal(mock.resets, 1);

      hold.resolve();
      const done = await first;
      assert.equal(done.statusCode, 200);
      const passed = done.json().results[0];
      assert.equal(passed.run.status, "passed");
      assert.equal(passed.trace.diagnosis, null);
      assert.equal(passed.trace.outcome.verifier.passed, true);
      assert.equal(passed.trace.outcome.success, true);

      const injected = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: "reference-shop", phase: "injected", task_ids: ["T3"] },
      });
      assert.equal(injected.statusCode, 200);
      assert.equal(Object.hasOwn(injected.json(), "error"), false);
      assert.equal(injected.json().results[0].run.status, "failed");
      assert.equal(injected.json().results[0].trace.outcome.verifier.passed, false);
      assert.equal(injected.json().results[0].trace.diagnosis, null);
      assert.ok(mock.resets >= 2);
    } finally {
      hold.resolve();
      await first.catch(() => undefined);
      await app.close();
    }
  });
});
