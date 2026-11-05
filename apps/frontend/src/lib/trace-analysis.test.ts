import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Diagnosis, Trace } from "@mesa/shared";
import { PRIMARY_NAV } from "./nav.ts";
import {
  ANALYSIS_SECTION_ID,
  DEMO_REFERENCE_SHOP_GITHUB_REPO_URL,
  TRACE_DETAIL_ROUTE,
  TRACE_EMPTY_PULL,
  TRACE_EMPTY_SEED,
  TRACE_LIST_ROUTE,
  analysisView,
  composeGitHubIssue,
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
  assert.equal(absent.step_id, null);
  assert.equal(absent.confidence, null);
  assert.deepEqual(absent.proposed_fixes, []);

  const present = analysisView(diagnosis());
  assert.equal(present.present, true);
  assert.equal(present.runDiagnosisCta, false);
  assert.equal(present.summary, "Cancelled the wrong order.");
  assert.equal(present.step_id, "s1");
  assert.equal(present.confidence, 0.8);
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

test("storyboard T3 fixture already has cause, step, confidence, and proposed_fixes", () => {
  const fixture = JSON.parse(
    readFileSync(join(here, "../../../../packages/shared/examples/injected-failed-trace.json"), "utf8"),
  ) as Trace;
  const view = analysisView(fixture.diagnosis);
  assert.equal(fixture.trace_id, "trace-t3-forged-checkout");
  assert.equal(view.present, true);
  assert.equal(view.runDiagnosisCta, false);
  assert.equal(typeof view.summary, "string");
  assert.ok(view.summary && view.summary.length > 0);
  assert.equal(view.step_id, fixture.diagnosis?.step_id);
  assert.equal(view.confidence, fixture.diagnosis?.confidence);
  assert.deepEqual(view.proposed_fixes, ["pre_response_check"]);
});

test("TracePage keeps iolmao diagnosis content and adds Run diagnosis plus run link", () => {
  const page = readFileSync(join(here, "../pages/TracePage.tsx"), "utf8");
  assert.match(page, /id=\{ANALYSIS_SECTION_ID\}/);
  assert.match(page, />Analysis</);
  assert.match(page, /Run diagnosis/);
  assert.match(page, /Diagnosis not available/);
  assert.match(page, /Proposed fixes/);
  assert.match(page, /trace\.diagnosis\.cause/);
  assert.match(page, /Failing step \{trace\.diagnosis\.step_id\}/);
  assert.match(page, /From run/);
  assert.match(page, /diagnoseTrace/);
  assert.match(page, /Open as GitHub issue/);
  assert.match(page, /composeGitHubIssue/);
  assert.match(page, /agent\?\.github_repo_url/);
  assert.match(page, /AfterFixPanel/);
  assert.doesNotMatch(page, /Giuria/);
  const panel = readFileSync(join(here, "../pages/AfterFixPanel.tsx"), "utf8");
  assert.match(panel, /"Verify fix"/);
  assert.match(panel, /Select fixes/);
  assert.match(panel, /AFTER_FIX_SECTION_ID/);
  assert.match(panel, /beforeAfterHeadline/);
  assert.match(page, /AFTER_FIX_SECTION_ID/);
});

test("Open as GitHub issue targets the reference-shop repo with title, cause, step, evidence, fix, and trace link", () => {
  const fixture = JSON.parse(
    readFileSync(join(here, "../../../../packages/shared/examples/injected-failed-trace.json"), "utf8"),
  ) as Trace;
  assert.ok(fixture.diagnosis);
  const missing = composeGitHubIssue({
    repoUrl: undefined,
    trace: fixture,
    diagnosis: fixture.diagnosis,
    origin: "https://mesa-frontend-rleq.onrender.com",
  });
  assert.equal(missing, null);

  const draft = composeGitHubIssue({
    repoUrl: DEMO_REFERENCE_SHOP_GITHUB_REPO_URL,
    trace: fixture,
    diagnosis: fixture.diagnosis,
    origin: "https://mesa-frontend-rleq.onrender.com",
  });
  assert.ok(draft);
  assert.match(draft.title, /T3/);
  assert.match(draft.title, /Verification/);
  assert.equal(
    draft.href.startsWith(`${DEMO_REFERENCE_SHOP_GITHUB_REPO_URL}/issues/new?title=`),
    true,
  );
  const parsed = new URL(draft.href);
  assert.equal(parsed.origin + parsed.pathname, `${DEMO_REFERENCE_SHOP_GITHUB_REPO_URL}/issues/new`);
  assert.equal(parsed.searchParams.get("title"), draft.title);
  const body = parsed.searchParams.get("body") ?? "";
  assert.match(body, /\*\*Cause:\*\*/);
  assert.equal(body.includes(fixture.diagnosis.cause), true);
  assert.match(body, new RegExp(`\\*\\*Step:\\*\\* ${fixture.diagnosis.step_id}`));
  assert.match(body, /Evidence/);
  for (const item of fixture.diagnosis.evidence) {
    assert.equal(body.includes(item), true);
  }
  assert.match(body, /pre_response_check/);
  assert.match(body, /trace-t3-forged-checkout/);
  assert.match(body, /https:\/\/mesa-frontend-rleq\.onrender\.com\/traces\/trace-t3-forged-checkout/);
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
