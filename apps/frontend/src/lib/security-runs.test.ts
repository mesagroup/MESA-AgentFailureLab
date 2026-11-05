import { FEATURES } from "@mesa/shared/robot-lab";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Run } from "@mesa/shared";
import { PRIMARY_NAV } from "./nav.ts";
import { formHints, sameVerdictLabel, validateJuryForm } from "./jury.ts";
import {
  JURY_LEGACY_PATH,
  SECURITY_BADGE_LABEL,
  SECURITY_FILTER_COPY,
  SECURITY_RUNS_HREF,
  filterRunsByType,
  isSecurityRun,
  juryLegacyRedirectTo,
  runsListTypeFromSearch,
} from "./security-runs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const frontendSrc = join(here, "..");

const ITALIAN_USER_COPY = /[àèéìòùÀÈÉÌÒÙ]|giuria|giurato|malevola|ispeziona|testa agente|riprova|avvia caso|permessi/i;

function run(partial: Partial<Run> & Pick<Run, "run_id">): Run {
  return {
    agent_id: "reference-shop",
    task_id: "T5",
    phase: "injected",
    status: "failed",
    trace_ids: [],
    injection_plan: null,
    fix_kinds: [],
    ...partial,
  };
}

const securityPlan = {
  fault: "unauthorized cancel via juror note",
  target: "cancel_order",
  ground_truth: { category: "Security" as const, code: "unauthorized_cancel_via_juror_note" },
};

test("legacy /jury redirects to the Runs security filter", () => {
  assert.equal(JURY_LEGACY_PATH, "/jury");
  assert.equal(juryLegacyRedirectTo(), SECURITY_RUNS_HREF);
  assert.equal(SECURITY_RUNS_HREF, "/runs?type=security");
  const app = readFileSync(join(frontendSrc, "App.tsx"), "utf8");
  assert.match(app, /JURY_LEGACY_PATH/);
  assert.match(app, /juryLegacyRedirectTo/);
  assert.match(app, /Navigate/);
  assert.doesNotMatch(app, /JuryPage/);
  assert.equal(existsSync(join(frontendSrc, "pages/JuryPage.tsx")), false);
});

test("primary nav has no standalone Jury/Giuria entry", () => {
  assert.equal(PRIMARY_NAV.some((item) => item.to === "/jury"), false);
  assert.equal(PRIMARY_NAV.some((item) => ITALIAN_USER_COPY.test(item.label)), false);
  assert.deepEqual(
    PRIMARY_NAV.map((item) => item.label),
    ["Dashboard", "Agents", "Runs", "Traces", "Eval", ...(FEATURES.robotLab ? ["Robot Lab"] : [])],
  );
});

test("security runs use injection_plan.ground_truth.category Security", () => {
  const attacked = run({ run_id: "run-attack", injection_plan: securityPlan, phase: "injected" });
  const baseline = run({ run_id: "run-base", phase: "baseline", injection_plan: null });
  const injectedOther = run({
    run_id: "run-inject",
    injection_plan: {
      fault: "drop",
      target: "search",
      ground_truth: { category: "Execution", code: "skipped_tool" },
    },
  });
  assert.equal(isSecurityRun(attacked), true);
  assert.equal(isSecurityRun(baseline), false);
  assert.equal(isSecurityRun(injectedOther), false);
  assert.equal(SECURITY_BADGE_LABEL, "Security");
});

test("Runs type=security filters to the Security badge set", () => {
  assert.equal(runsListTypeFromSearch("?type=security"), "security");
  assert.equal(runsListTypeFromSearch("type=security"), "security");
  assert.equal(runsListTypeFromSearch(""), "all");
  assert.equal(runsListTypeFromSearch("?type=baseline"), "all");
  const rows = [
    run({ run_id: "run-attack", injection_plan: securityPlan }),
    run({ run_id: "run-base", phase: "baseline" }),
  ];
  assert.deepEqual(filterRunsByType(rows, "security").map((item) => item.run_id), ["run-attack"]);
  assert.deepEqual(filterRunsByType(rows, "all").map((item) => item.run_id), ["run-attack", "run-base"]);
});

test("jury/security user-facing copy is English", () => {
  const blobs = [
    ...PRIMARY_NAV.map((item) => item.label),
    SECURITY_BADGE_LABEL,
    SECURITY_FILTER_COPY.title,
    SECURITY_FILTER_COPY.detail,
    SECURITY_FILTER_COPY.launch,
    SECURITY_FILTER_COPY.empty,
    ...Object.values(formHints(null)),
    validateJuryForm({ note: "   ", taskId: "T5", permissions: ["read"], includeBaseline: true }) ?? "",
    sameVerdictLabel(true),
  ];
  for (const text of blobs) {
    assert.equal(ITALIAN_USER_COPY.test(text), false, text);
  }
  assert.match(SECURITY_FILTER_COPY.detail, /attacker/i);
  assert.match(SECURITY_FILTER_COPY.detail, /malicious juror note/i);
  assert.match(SECURITY_FILTER_COPY.detail, /permission guard/i);
});

test("dashboard has no Security/Jury destination strip; security stays under Runs", () => {
  const dashboardPage = readFileSync(join(frontendSrc, "pages/DashboardPage.tsx"), "utf8");
  const dashboardLib = readFileSync(join(frontendSrc, "lib/dashboard.ts"), "utf8");
  assert.doesNotMatch(dashboardLib, /DASHBOARD_DESTINATIONS/);
  assert.doesNotMatch(dashboardPage, /DASHBOARD_DESTINATIONS|\/jury|Giuria/);
  assert.doesNotMatch(dashboardPage, /title:\s*"Security"/);
  assert.match(SECURITY_RUNS_HREF, /type=security/);
});
