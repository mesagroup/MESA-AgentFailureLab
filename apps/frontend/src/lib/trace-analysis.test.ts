import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Diagnosis } from "@mesa/shared";
import { PRIMARY_NAV } from "./nav.ts";
import {
  ANALYSIS_SECTION_ID,
  TRACE_DETAIL_ROUTE,
  TRACE_EMPTY_PULL,
  TRACE_EMPTY_SEED,
  TRACE_LIST_ROUTE,
  analysisView,
  describeDiagnoseFailure,
  diagnosePath,
  parentRunHref,
  parseDiagnoseTrace,
  traceDetailHref,
  tracesIndexEmptyCopy,
} from "./trace-analysis.ts";

const here = dirname(fileURLToPath(import.meta.url));

function diagnosis(partial: Partial<Diagnosis> = {}): Diagnosis {
  return {
    category: "wrong_action",
    cause: "Cancelled the wrong order.",
    step_id: "s1",
    confidence: 0.8,
    evidence: ["tool_call cancel_order"],
    proposed_fixes: ["permission_guard"],
    ...partial,
  };
}

test("nav Traces is the non-stub index, and detail URLs are bookmarkable", () => {
  const tracesItem = PRIMARY_NAV.find((item) => item.label === "Traces");
  assert.equal(tracesItem?.to, TRACE_LIST_ROUTE);
  assert.equal(TRACE_DETAIL_ROUTE, "/traces/:traceId");
  assert.equal(traceDetailHref("shop-a-prod-t1"), "/traces/shop-a-prod-t1");
  assert.equal(traceDetailHref("shop-a-prod-t1", true), "/traces/shop-a-prod-t1#analysis");
  assert.equal(traceDetailHref("id with space", true), "/traces/id%20with%20space#analysis");
  assert.equal(parentRunHref("run-shop-a-prod-t1"), "/runs/run-shop-a-prod-t1");
  assert.equal(parentRunHref(""), null);
  assert.equal(diagnosePath("shop-a-prod-t1"), "/traces/shop-a-prod-t1/diagnose");
});

test("empty traces copy names Seed demo traces and Pull telemetry", () => {
  const none = tracesIndexEmptyCopy("none");
  assert.match(none, new RegExp(TRACE_EMPTY_SEED));
  assert.match(none, new RegExp(TRACE_EMPTY_PULL));
  assert.equal(tracesIndexEmptyCopy("filtered"), "No traces match these filters.");
  assert.equal(tracesIndexEmptyCopy("error"), "The list could not be loaded.");
});

test("analysis is always a panel: CTA when absent, summary and proposed_fixes when present", () => {
  const absent = analysisView(null);
  assert.equal(absent.present, false);
  assert.equal(absent.runDiagnosisCta, true);
  assert.equal(absent.summary, null);
  assert.deepEqual(absent.proposed_fixes, []);

  const present = analysisView(diagnosis());
  assert.equal(present.present, true);
  assert.equal(present.runDiagnosisCta, false);
  assert.equal(present.summary, "Cancelled the wrong order.");
  assert.deepEqual(present.proposed_fixes, ["permission_guard"]);
});

test("diagnose POST maps 409 busy and changed separately from a missing body", () => {
  const parsed = parseDiagnoseTrace({
    trace_id: "t1",
    diagnosis: diagnosis(),
  });
  assert.equal(parsed.ok, true);
  assert.equal(parseDiagnoseTrace({ agent_id: "x" }).ok, false);
  assert.match(describeDiagnoseFailure({ status: 409, code: "diagnosis_busy", message: "busy" }), /diagnosis_busy/);
  assert.match(describeDiagnoseFailure({ status: 409, code: "trace_changed", message: "changed" }), /changed/);
  assert.doesNotMatch(describeDiagnoseFailure({ status: 409, code: "diagnosis_busy", message: "busy" }), /world_busy/);
});

test("TracePage keeps iolmao diagnosis content and adds Run diagnosis plus run link", () => {
  const page = readFileSync(join(here, "../pages/TracePage.tsx"), "utf8");
  assert.match(page, /id=\{ANALYSIS_SECTION_ID\}/);
  assert.match(page, />Analysis</);
  assert.match(page, /Run diagnosis/);
  assert.match(page, /Diagnosis not available/);
  assert.match(page, /Proposed fixes/);
  assert.match(page, /trace\.diagnosis\.cause/);
  assert.match(page, /Open parent run/);
  assert.match(page, /diagnoseTrace/);
  assert.match(page, /Open as GitHub issue/);
  assert.doesNotMatch(page, /Giuria/);
});

test("traces index empty state and pull panel stay on the list page", () => {
  const index = readFileSync(join(here, "../pages/TracesIndexPage.tsx"), "utf8");
  const app = readFileSync(join(here, "../App.tsx"), "utf8");
  const pull = readFileSync(join(here, "../pages/TracePullPanel.tsx"), "utf8");
  assert.match(app, /path="\/traces\/:traceId"/);
  assert.match(app, /path="\/traces"/);
  assert.match(index, /tracesIndexEmptyCopy/);
  assert.match(index, /to=\{`\/traces\/\$\{encodeURIComponent\(trace\.trace_id\)\}`\}/);
  assert.match(index, /TracePullPanel/);
  assert.match(pull, /id="pull-telemetry"/);
});
