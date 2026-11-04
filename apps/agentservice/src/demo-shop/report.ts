import type { DemoReport } from "./run.js";

function cell(value: unknown): string {
  return String(value ?? "n/a").replace(/\r?\n/g, " ").replace(/`/g, "'").replace(/\|/g, "\\|")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderShopDemoMarkdown(report: DemoReport): string {
  const lines = ["# Shop experiment", "", `Mode: **${report.mode}**. Scenario: ${cell(report.scenario.scenario_id)}.`, "",
    `Verdict: **${report.verdict.status}**; fix_verified: **${cell(report.verdict.fix_verified)}**.`,
    report.verdict.reason, "", `Regression: ${report.verdict.regression}; controls complete: ${report.verdict.regressions_complete}.`, "",
    `Client commit: ${cell(report.code.client_commit)}; dirty: ${report.code.dirty}. Backend/planner commit: n/a (not exposed by health).`,
    `Agent snapshot SHA256: ${cell(report.configuration?.agent_sha256)}.`,
    `Fix source: ${report.selection.source}; proposed: ${cell(report.selection.proposed.join(", ") || "none")}; applied: ${cell(report.selection.applied.join(", ") || "none")}.`, "",
    "| Role | Task | Verifier | Claim | Failed checks / error | Run | Trace | Wall ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const attempt of report.attempts) {
    const failed = attempt.trace?.outcome.verifier.checks.filter(check => !check.passed).map(check => `${check.name}: ${check.detail}`).join("; ");
    lines.push(`| ${attempt.role} | ${cell(attempt.task_id)} | ${attempt.passed === null ? "error / unscored" : attempt.passed ? "pass" : "fail"} | ${cell(attempt.trace?.outcome.agent_claimed_success)} | ${cell(attempt.error ?? failed ?? "")} | ${cell(attempt.run?.run_id)} | ${cell(attempt.trace?.trace_id)} | ${cell(attempt.run?.duration_ms)} |`);
  }
  lines.push("", "## Diagnosis", "", `Status: ${report.diagnosis.status}; cached: ${cell(report.diagnosis.cached)}; backend lookup-to-save wall ms: ${cell(report.diagnosis.backend_wall_ms)}.`,
    "Provider model, tokens and cost: n/a (not returned by the upstream contract). Harness totals are not diagnosis usage.");
  const diagnosis = report.diagnosis.trace?.diagnosis;
  if (diagnosis) {
    lines.push("", `Category: ${cell(diagnosis.category)}; step: ${cell(diagnosis.step_id)}; confidence: ${diagnosis.confidence}.`,
      cell(diagnosis.cause), ...diagnosis.evidence.map(evidence => `- ${cell(evidence)}`));
  }
  lines.push("", "## Errors and skipped work", "",
    ...report.errors.map(error => `- ${cell(error.stage)}: ${cell(error.code)}`),
    ...report.skipped.map(reason => `- ${cell(reason)}`));
  if (!report.errors.length && !report.skipped.length) lines.push("None.");
  lines.push("", "## Interpretation", "",
    "The JSON report contains the original Run/Trace documents, frozen Agent/scenario and parent links. The verifier alone supplies pass/fail; the agent claim and Grok diagnosis are separate.",
    "Every arm uses HTTP and the same planner endpoint, scenario and grant. Clean treated controls use the exact selected fix list and no injection.",
    "Step latency in Trace.totals is currently synthetic; Run.duration_ms is harness wall time. No provider price is inferred.",
    report.mode === "offline" ? "Offline run: isolated loopback services and an explicitly injected model fixture. This is not a live Grok result."
      : "Live mode requests configured services with no model fallback; health configuration alone does not prove provider availability or model quality.",
    "One run is a controlled example, not a statistical estimate of general efficacy. A single backend process and dedicated mock are required; the gate is not distributed.", "");
  return lines.join("\n");
}
