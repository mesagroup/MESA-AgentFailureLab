import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { INJECTED_LAUNCH_COPY, JURY_LAUNCH_COPY, LAUNCH_PHASE_COPY, LAUNCH_PHASES } from "./run-launch.ts";

const sheet = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../pages/AgentsPage.tsx"),
  "utf8",
);

test("RunSheet lists jury as a first-class launch phase", () => {
  assert.ok(LAUNCH_PHASES.includes("jury"));
  assert.match(sheet, /LAUNCH_PHASES\.map/);
  assert.match(sheet, /LAUNCH_PHASE_COPY\[p\]\.label/);
  assert.match(sheet, /phase === "jury"/);
  assert.match(sheet, /JuryLaunchFields/);
  assert.match(sheet, /aria-label="Launch phase"/);
  assert.match(sheet, /postJuryCase/);
  assert.match(sheet, /getJuryCase/);
  assert.match(sheet, /hrefAfterJuryLaunch/);
  assert.match(sheet, /buildLaunchRequest/);
  assert.doesNotMatch(sheet, /Giuria/);
  assert.doesNotMatch(sheet, /font-mono">\{p === "jury" \? "jury" : p\}/);
});

test("RunSheet phase picker uses plain-English labels", () => {
  assert.equal(LAUNCH_PHASE_COPY.baseline.label, "Clean run");
  assert.equal(LAUNCH_PHASE_COPY.injected.label, "Inject fault");
  assert.equal(LAUNCH_PHASE_COPY.jury.label, "Security attack");
  assert.equal(LAUNCH_PHASE_COPY.after_fix.label, "Verify fix");
  assert.match(sheet, /LAUNCH_PHASE_COPY\[p\]\.subtitle/);
  assert.match(sheet, /runPhaseLabel\(run\.phase\)/);
});

test("RunSheet jury UI collects note, permissions, reference run, and in-flight guards", () => {
  assert.match(sheet, /id="jury-note"/);
  assert.match(sheet, /JURY_LAUNCH_COPY\.noteLabel/);
  assert.match(sheet, /JURY_LAUNCH_COPY\.permissionsLabel/);
  assert.match(sheet, /name="jury-reference"/);
  assert.match(sheet, /aria-busy=\{launching \|\| juryLoading \|\| loadingRuns\}/);
  assert.match(sheet, /disabled=\{launching \|\| !launchReady\}/);
  assert.match(sheet, /aria-busy=\{launching\}/);
  assert.match(sheet, /if \(!agent \|\| launching\) return/);
  assert.match(sheet, /if \(!open && !launching\) onClose\(\)/);
  assert.match(JURY_LAUNCH_COPY.helper, /Security launch mode/i);
  assert.match(JURY_LAUNCH_COPY.helper, /not a stored run phase/i);
  assert.match(JURY_LAUNCH_COPY.helper, /permission check/i);
  assert.match(JURY_LAUNCH_COPY.noteLabel, /Attack note/);
  assert.doesNotMatch(JURY_LAUNCH_COPY.helper, /\/attacker\/jury-case/);
});

test("RunSheet injected phase shows an accessible info tooltip next to the baseline picker heading", () => {
  assert.match(sheet, /InjectedPhaseInfo/);
  assert.match(sheet, /phase === "injected" \? <InjectedPhaseInfo/);
  assert.match(sheet, /Baseline run to inject/);
  assert.match(INJECTED_LAUNCH_COPY.buttonLabel, /About inject fault/);
  assert.match(INJECTED_LAUNCH_COPY.tooltip, /previous completed baseline/i);
  assert.match(INJECTED_LAUNCH_COPY.tooltip, /malicious prompt/i);
  assert.match(INJECTED_LAUNCH_COPY.tooltip, /automatic platform service/i);
  assert.match(INJECTED_LAUNCH_COPY.tooltip, /transparent to the agent's end user/i);
  assert.match(sheet, /parentRunId/);
  assert.match(sheet, /PromptLaunchEditor/);
  assert.match(sheet, /launchPromptOverride/);
});

test("RunSheet jury phase reuses Prompt for this launch from the reference task", () => {
  assert.match(sheet, /selectedJuryTask/);
  assert.match(sheet, /PromptLaunchEditor/);
  assert.match(sheet, /PROMPT_LAUNCH_COPY\.helperJury/);
  assert.match(sheet, /prefillKey=\{`jury:\$\{selectedRun\.run_id\}`\}/);
  assert.match(JURY_LAUNCH_COPY.promptLabel, /Prompt for this launch/);
  assert.match(JURY_LAUNCH_COPY.promptHelper, /Starts from the reference task\. Edit before launch\./);
  assert.match(sheet, /phase === "injected" \|\| phase === "after_fix" \|\| phase === "jury"/);
  assert.match(sheet, /launchPromptOverride/);
  assert.match(sheet, /Task prompt/);
});
