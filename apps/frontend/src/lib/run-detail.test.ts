import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Agent, Run, Trace } from "@mesa/shared";
import {
  RUNS_DETAIL_ROUTE,
  RUNS_LIST_ROUTE,
  buildRunDetailView,
  decodeRunIdParam,
  loadRunDetail,
  runListClickHref,
  shouldPollRun,
} from "./run-detail.ts";

function run(partial: Partial<Run> & Pick<Run, "run_id">): Run {
  return {
    agent_id: "reference-shop",
    task_id: "T5",
    phase: "baseline",
    status: "passed",
    trace_ids: [],
    injection_plan: null,
    fix_kinds: [],
    ...partial,
  };
}

function agent(partial: Partial<Agent> = {}): Agent {
  return {
    agent_id: "reference-shop",
    name: "Reference shop",
    description: "demo",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    instance: { kind: "reference", base_url: "http://shop", runtime: "grok" },
    test_instance: { base_url: "http://shop", runtime: "grok" },
    traces: { store: "path", path_or_url: "pending" },
    docs: { prompt_summary: "", tools: [], constraints: [], config_notes: "" },
    tasks: [
      {
        task_id: "T5",
        title: "Cancel last order",
        prompt: "Cancel the customer's last order.",
        setup: {
          cart: [{ sku: "sku-1", qty: 1 }],
          orders: [{ from_cart: true }],
          permissions: ["orders:write"],
        },
        success_test: { type: "verifier_checks", checks: [{ name: "order_cancelled", description: "Order is cancelled" }] },
      },
    ],
    ...partial,
  };
}

function trace(partial: Partial<Trace> = {}): Trace {
  return {
    trace_id: "trace-ok",
    agent_id: "reference-shop",
    run_id: "run-ok",
    task_id: "T5",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:02.000Z",
    status: "completed",
    steps: [],
    outcome: {
      success: true,
      verifier: {
        passed: true,
        checks: [
          { name: "order_cancelled", passed: true, detail: "cancelled" },
          { name: "no_extra_charge", passed: true, detail: "ok" },
        ],
        mock_state_snapshot: {},
      },
      agent_claimed_success: true,
    },
    totals: { latency_ms: 2000, tokens_in: 1, tokens_out: 1, cost_usd: 0 },
    fault: { injected: false, labels: [], attacker: { used: false, payload_id: null } },
    diagnosis: null,
    ...partial,
  };
}

test("list click always opens /runs/:runId, never /traces", () => {
  assert.equal(runListClickHref(run({ run_id: "run-with-trace", trace_ids: ["trace-1"] })), "/runs/run-with-trace");
  assert.equal(runListClickHref(run({ run_id: "run-no-trace" })), "/runs/run-no-trace");
  assert.equal(
    runListClickHref(run({ run_id: "run/odd id" })),
    "/runs/run%2Fodd%20id",
  );
  assert.equal(RUNS_DETAIL_ROUTE, "/runs/:runId");
  assert.equal(RUNS_LIST_ROUTE, "/runs");
  assert.notEqual(RUNS_DETAIL_ROUTE, RUNS_LIST_ROUTE);
});

test("decodeRunIdParam round-trips encoded ids", () => {
  assert.equal(decodeRunIdParam("run-plain"), "run-plain");
  assert.equal(decodeRunIdParam(encodeURIComponent("run/odd id")), "run/odd id");
  assert.equal(decodeRunIdParam(undefined), "");
});

test("verified run renders prompt, task, and each verifier check", () => {
  const view = buildRunDetailView({
    run: run({ run_id: "run-ok", status: "passed", trace_ids: ["trace-ok"] }),
    agent: agent(),
    trace: trace(),
  });
  assert.equal(view.agent_name, "Reference shop");
  assert.equal(view.task.title, "Cancel last order");
  assert.equal(view.task.prompt, "Cancel the customer's last order.");
  assert.match(view.task.setup_summary, /cart line/);
  assert.equal(view.verifier?.passed, true);
  assert.equal(view.verifier?.checks.length, 2);
  assert.equal(view.verifier?.checks[0]?.name, "order_cancelled");
  assert.equal(view.trace_href, "/traces/trace-ok");
  assert.equal(view.trace_empty, null);
  assert.equal(view.verifier_empty, null);
  assert.equal(view.notes, null);
});

test("failed run keeps verifier checks prominent and shows a failed banner", () => {
  const failed = trace({
    trace_id: "trace-fail",
    status: "failed",
    outcome: {
      success: false,
      verifier: {
        passed: false,
        checks: [{ name: "order_cancelled", passed: false, detail: "still open" }],
        mock_state_snapshot: {},
      },
      agent_claimed_success: true,
    },
  });
  const view = buildRunDetailView({
    run: run({ run_id: "run-fail", phase: "injected", status: "failed", trace_ids: ["trace-fail"] }),
    agent: agent(),
    trace: failed,
  });
  assert.equal(view.verifier?.passed, false);
  assert.equal(view.verifier?.checks[0]?.passed, false);
  assert.equal(view.banners[0]?.kind, "failed");
  assert.equal(view.trace_href, "/traces/trace-fail");
});

test("error run with no trace still shows harness error and an empty verifier", () => {
  const view = buildRunDetailView({
    run: run({
      run_id: "run-error",
      status: "error",
      trace_ids: [],
      error_message: "Agent 1 external, task search: seeding 400",
    }),
    agent: agent(),
  });
  assert.equal(view.trace_href, null);
  assert.match(view.trace_empty ?? "", /No trace/);
  assert.match(view.verifier_empty ?? "", /has none/);
  assert.equal(view.banners[0]?.kind, "error");
  assert.match(view.banners[0]?.message ?? "", /seeding 400/);
});

test("running and queued runs explain why the payload is incomplete", () => {
  const running = buildRunDetailView({ run: run({ run_id: "run-run", status: "running" }) });
  const queued = buildRunDetailView({ run: run({ run_id: "run-q", status: "queued" }) });
  assert.equal(running.banners[0]?.kind, "running");
  assert.equal(queued.banners[0]?.kind, "queued");
  assert.equal(shouldPollRun(running.run), true);
  assert.equal(shouldPollRun(queued.run), true);
  assert.equal(shouldPollRun(run({ run_id: "done" })), false);
});

test("loadRunDetail maps 404 and 500 without a silent empty page", async () => {
  const missing = await loadRunDetail("run-missing", {
    getRun: async () => {
      throw Object.assign(new Error("No run run-missing"), { status: 404 });
    },
    getAgent: async () => undefined,
    getTrace: async () => {
      throw new Error("not called");
    },
  });
  assert.equal(missing.status, "not_found");
  if (missing.status === "not_found") assert.match(missing.message, /run-missing/);

  const boom = await loadRunDetail("run-500", {
    getRun: async () => {
      throw Object.assign(new Error("Stored run failed schema"), { status: 500 });
    },
    getAgent: async () => undefined,
    getTrace: async () => {
      throw new Error("not called");
    },
  });
  assert.equal(boom.status, "error");
  if (boom.status === "error") {
    assert.equal(boom.httpStatus, 500);
    assert.match(boom.message, /schema/);
  }
});

test("loadRunDetail keeps the run when GET /traces fails", async () => {
  const loaded = await loadRunDetail("run-ok", {
    getRun: async () => run({ run_id: "run-ok", trace_ids: ["trace-ok"], status: "passed" }),
    getAgent: async () => agent(),
    getTrace: async () => {
      throw Object.assign(new Error("No trace trace-ok"), { status: 404 });
    },
  });
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") return;
  assert.equal(loaded.view.run.run_id, "run-ok");
  assert.equal(loaded.view.verifier, null);
  assert.match(loaded.view.banners.map((item) => item.message).join(" "), /GET \/traces failed/);
});

test("loadRunDetail attaches verifier from the trace document", async () => {
  const loaded = await loadRunDetail("run-ok", {
    getRun: async () => run({ run_id: "run-ok", trace_ids: ["trace-ok"] }),
    getAgent: async () => agent(),
    getTrace: async () => trace(),
  });
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") return;
  assert.equal(loaded.view.verifier?.passed, true);
  assert.equal(loaded.view.task.prompt.length > 0, true);
});

test("diagnosis notes stay off the verifier block", () => {
  const view = buildRunDetailView({
    run: run({ run_id: "run-ok", trace_ids: ["trace-ok"] }),
    trace: trace({
      diagnosis: {
        category: "wrong_action",
        cause: "Cancelled the wrong order.",
        step_id: "s1",
        confidence: 0.4,
        evidence: [],
        proposed_fixes: ["permission_guard"],
      },
    }),
  });
  assert.equal(view.notes?.title, "Diagnosis note");
  assert.equal(view.notes?.body, "Cancelled the wrong order.");
  assert.equal(view.verifier?.passed, true);
});

test("nginx SPA fallback serves /runs/:runId as index.html", () => {
  const template = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../nginx/default.conf.template"),
    "utf8",
  );
  assert.match(template, /try_files \$uri \$uri\/ \/index\.html;/);
});
