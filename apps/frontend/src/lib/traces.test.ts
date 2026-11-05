import assert from "node:assert/strict";
import test from "node:test";
import type { Trace } from "@mesa/shared";
import {
  DEMO_SEED_TRACE_IDS,
  describePullFailure,
  describeTraceListFailure,
  formatCursor,
  formatPullError,
  parseOtelPullCursors,
  parseTraceList,
  parseTracePullResult,
  pullResultSummary,
  traceListPath,
  traceListSource,
  tracePullBody,
} from "./traces.ts";

function sampleTrace(partial: Pick<Trace, "trace_id" | "agent_id" | "started_at"> & Partial<Trace>): Trace {
  return {
    run_id: "run-1",
    task_id: "T1",
    ended_at: partial.started_at,
    status: "completed",
    steps: [],
    outcome: {
      success: true,
      verifier: { passed: true, checks: [], mock_state_snapshot: {} },
      agent_claimed_success: true,
    },
    totals: { latency_ms: 1, tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    fault: { injected: false, labels: [], attacker: { used: false, payload_id: null } },
    diagnosis: null,
    ...partial,
  };
}

const sourceResult = {
  source: "prod",
  tag: "otel_prod",
  transport: "http",
  since: null,
  until: "2026-11-05T08:40:00.000Z",
  previous_last_pull_at: null,
  last_pull_at: "2026-11-05T08:40:00.000Z",
  imported: 1,
  skipped: 0,
  failed: 0,
  empty: false,
  message: "Imported 1 trace.",
  trace_ids: ["shop-a-prod-t1"],
  errors: [],
};

test("list tags use Trace.source, then the demo seed ids", () => {
  const seeded = sampleTrace({ trace_id: DEMO_SEED_TRACE_IDS[0], agent_id: "reference-shop", started_at: "2026-11-03T14:12:08.014Z" });
  const harness = sampleTrace({ trace_id: "trace-harness-1", agent_id: "reference-shop", started_at: "2026-11-05T08:00:00.000Z", source: "harness" });
  const pulled = sampleTrace({ trace_id: "shop-a-prod-t1", agent_id: "reference-shop", started_at: "2026-11-03T14:12:08.014Z", source: "otel_prod" });
  assert.equal(traceListSource(seeded), "demo_seed");
  assert.equal(traceListSource(harness), "harness");
  assert.equal(traceListSource(pulled), "otel_prod");

  const parsed = parseTraceList({ traces: [seeded, pulled] });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.traces.length, 2);
  assert.equal(parseTraceList({ traces: [{ trace_id: "x" }] }).ok, false);
  const bad = parseTraceList({ traces: [{ ...harness, source: "live" }] });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.message, /otel_test/);
  assert.match(describeTraceListFailure({ status: 400, message: "since must be an ISO-8601 date-time.", code: "invalid_request" }), /HTTP 400 invalid_request/);
});

test("list filters are the lab query names", () => {
  const path = traceListPath({
    agentId: "reference-shop",
    source: "otel_prod",
    from: "2026-11-03T00:00:00.000Z",
    to: "2026-11-05T00:00:00.000Z",
  });
  assert.equal(path.ok, true);
  if (path.ok) {
    const params = new URLSearchParams({
      agent_id: "reference-shop",
      source: "otel_prod",
      since: "2026-11-03T00:00:00.000Z",
      until: "2026-11-05T00:00:00.000Z",
    });
    assert.equal(path.path, `/traces?${params.toString()}`);
  }
  assert.equal(traceListPath({ agentId: "", source: "", from: "", to: "" }).ok, true);
  const inverted = traceListPath({
    agentId: "",
    source: "",
    from: "2026-11-06T00:00:00.000Z",
    to: "2026-11-05T00:00:00.000Z",
  });
  assert.equal(inverted.ok, false);
  if (!inverted.ok) assert.match(inverted.message, /after the end/);
});

test("the first pull omits since", () => {
  const open = tracePullBody({ sources: ["test", "prod"], since: "  " });
  assert.equal(open.ok, true);
  if (open.ok) {
    assert.deepEqual(open.body, { sources: ["prod", "test"] });
    assert.equal(JSON.stringify(open.body).includes("since"), false);
  }
  const bounded = tracePullBody({ sources: ["prod"], since: "2026-11-01T00:00:00.000Z" });
  assert.equal(bounded.ok, true);
  if (bounded.ok) assert.equal(bounded.body.since, "2026-11-01T00:00:00.000Z");
  assert.match(tracePullBody({ sources: [], since: "" }).message ?? "", /prod, test, or both/);
});

test("pull results keep counts, empty windows, and the five error kinds", () => {
  const parsed = parseTracePullResult({
    agent_id: "reference-shop",
    imported: 1,
    skipped: 0,
    failed: 1,
    sources: [
      sourceResult,
      {
        ...sourceResult,
        source: "test",
        tag: "otel_test",
        imported: 0,
        failed: 1,
        empty: false,
        last_pull_at: null,
        message: "schema_id is not mesa.otel.shop.a",
        trace_ids: [],
        errors: [{ source: "test", kind: "remap", message: "schema_id is not mesa.otel.shop.a" }],
      },
    ],
    errors: [{ source: "test", kind: "remap", message: "schema_id is not mesa.otel.shop.a" }],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.failed, 1);
  assert.match(formatPullError(parsed.value.errors[0]!), /schema remap/);
  assert.match(pullResultSummary(parsed.value), /Imported 1/);

  const empty = parseTracePullResult({
    agent_id: "reference-shop",
    imported: 0,
    skipped: 0,
    failed: 0,
    sources: [{ ...sourceResult, imported: 0, empty: true, message: "The endpoint returned no spans.", trace_ids: [] }],
    errors: [],
  });
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.equal(empty.value.sources[0]?.empty, true);
    assert.equal(empty.value.failed, 0);
    assert.match(pullResultSummary(empty.value), /Empty window/);
    assert.match(pullResultSummary(empty.value), /no spans/);
  }

  for (const kind of ["network", "auth", "validation", "conflict"] as const) {
    const result = parseTracePullResult({
      agent_id: "reference-shop",
      imported: 0,
      skipped: 0,
      failed: 1,
      sources: [sourceResult],
      errors: [{ source: "prod", kind, message: `${kind} failed` }],
    });
    assert.equal(result.ok, true, kind);
  }
  assert.match(parseTracePullResult({ imported: 1, skipped: 0, failed: 0 }).message ?? "", /imported, skipped, and failed/);
  assert.match(
    parseTracePullResult({
      agent_id: "reference-shop",
      imported: 0,
      skipped: 0,
      failed: 1,
      sources: [],
      errors: [{ source: "prod", kind: "other", message: "nope" }],
    }).message ?? "",
    /validation, or conflict/,
  );
});

test("cursors and rejected pulls stay visible", () => {
  const cursors = parseOtelPullCursors({
    agent_id: "reference-shop",
    prod: { tag: "otel_prod", last_pull_at: "2026-11-05T08:40:00.000Z" },
    test: { tag: "otel_test", last_pull_at: null },
  });
  assert.equal(cursors.ok, true);
  if (cursors.ok) {
    assert.equal(formatCursor(cursors.value.prod.last_pull_at), "2026-11-05T08:40:00.000Z");
    assert.match(formatCursor(cursors.value.test.last_pull_at), /No successful pull yet/);
  }
  const missing = describePullFailure({
    status: 400,
    code: "otel_not_configured",
    message: "Agent reference-shop has no otel source. Register otel.prod and otel.test before pulling traces.",
  });
  assert.match(missing.message, /Register otel.prod/);
  assert.equal(missing.details, "HTTP 400 otel_not_configured");
  assert.match(describePullFailure(new TypeError("Failed to fetch")).message, /could not reach the lab/);
});
