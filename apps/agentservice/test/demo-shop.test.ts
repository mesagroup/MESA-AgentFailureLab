import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Agent, FixKind, Trace } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";
import { parseShopScenario } from "../src/demo-shop/scenario.js";
import { runShopDemo, type DemoOptions, type DemoReport } from "../src/demo-shop/run.js";
import { renderShopDemoMarkdown } from "../src/demo-shop/report.js";
import { startOfflineShop } from "../scripts/demo-shop-offline.js";
import { demoShopCli, parseDemoArgs, writeDemoReports } from "../scripts/demo-shop.js";

const rawScenario = JSON.parse(readFileSync(new URL("../scenarios/shop-readback-v1/scenario.json", import.meta.url), "utf8"));
const scenario = () => parseShopScenario(rawScenario);
function agent(): Agent {
  const parsed = validateAgent(JSON.parse(readFileSync(new URL("../scenarios/shop-readback-v1/agent.json", import.meta.url), "utf8")));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
}
const code = { client_commit: "offline-test-fixture", dirty: false };
function options(lab: Awaited<ReturnType<typeof startOfflineShop>>): DemoOptions {
  return { mode: "offline", backendUrl: lab.backendUrl, agentId: lab.agent.agent_id, scenario: scenario(), code };
}
function modelWith(fixes: FixKind[]) {
  return { complete: async (request: { user: string }) => {
    const view = JSON.parse(request.user) as { steps: Trace["steps"]; fault?: unknown; outcome?: unknown };
    assert.equal(view.fault, undefined); assert.equal(view.outcome, undefined);
    const step = [...view.steps].reverse().find(step => step.type === "message" && step.role === "assistant")!;
    return { content: JSON.stringify({ category: "Verification", cause: "Explicit offline fixture", step_id: step.step_id,
      confidence: 0.8, evidence: [`${step.step_id} claims completion`], proposed_fixes: fixes }), usage: null };
  } };
}

describe("shop demo HTTP orchestration (explicit offline tests)", { concurrency: false }, () => {
  it("uses the registered agent and persisted diagnosis, same fault/driver/treatment, all clean controls", async () => {
    const lab = await startOfflineShop(agent());
    const sent: Record<string, unknown>[] = [];
    const proxy: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/runs") && init?.method === "POST") sent.push(JSON.parse(init.body as string));
      return fetch(url, init);
    };
    try {
      const report = await runShopDemo(options(lab), proxy);
      assert.equal(report.exit_code, 0);
      assert.equal(report.verdict.fix_verified, true);
      assert.equal(report.verdict.regressions_complete, true);
      assert.equal(report.attempts.length, 13);
      assert.deepEqual(report.attempts.slice(0, 3).map(arm => arm.passed), [true, false, true]);
      assert.equal(report.selection.source, "offline_model");
      assert.deepEqual(report.selection.applied, ["pre_response_check"]);
      assert.deepEqual(report.diagnosis.trace, await lab.store.getTrace(report.diagnosis.trace!.trace_id));
      assert.equal(report.diagnosis.model, null); assert.equal(report.diagnosis.usage, null);
      assert.equal(report.code.backend_commit, null);
      assert.deepEqual(sent[1].injection, sent[2].injection);
      assert.equal(sent[2].parent_run_id, report.attempts[1].run!.run_id);
      for (let i = 0; i < sent.length; i++) {
        assert.equal(sent[i].driver, "http");
        assert.equal(sent[i].agent_id, lab.agent.agent_id);
        if (sent[i].phase === "after_fix") assert.deepEqual(sent[i].fix_kinds, report.selection.applied);
        else assert.equal(sent[i].fix_kinds, undefined);
        if (i >= 3) assert.equal(sent[i].injection, null);
      }
      const markdown = renderShopDemoMarkdown(report);
      assert.match(markdown, /Mode: \*\*offline\*\*/);
      assert.match(markdown, /model, tokens and cost: n\/a/);
      assert.match(markdown, /product_viewed/);
      assert.match(markdown, /not a live Grok result/);
      assert.equal((await lab.agents.get(lab.agent.agent_id))?.updated_at, lab.agent.updated_at);
    } finally { await lab.close(); }
  });

  for (const proposed of [[], ["permission_guard"] as FixKind[]]) {
    it(`does not substitute the answer key for proposal ${JSON.stringify(proposed)}`, async () => {
      const lab = await startOfflineShop(agent(), modelWith(proposed));
      try {
        const parsed = parseShopScenario({ ...rawScenario, test_expectations: { reference_fix: "controlled_retry" } });
        assert.equal(Object.hasOwn(parsed, "test_expectations"), false);
        const report = await runShopDemo({ ...options(lab), scenario: parsed });
        assert.equal(report.exit_code, 2);
        assert.deepEqual(report.selection.applied, proposed);
        assert.notEqual(report.verdict.fix_verified, true);
        assert.equal(report.attempts.length, proposed.length ? 13 : 2);
        if (!proposed.length) assert.ok(report.skipped.length);
      } finally { await lab.close(); }
    });
  }

  it("records an explicit human intervention separately from the model proposal", async () => {
    const lab = await startOfflineShop(agent(), modelWith(["permission_guard"]));
    try {
      const report = await runShopDemo({ ...options(lab), manualFixes: ["pre_response_check"] });
      assert.equal(report.exit_code, 0);
      assert.equal(report.selection.source, "manual");
      assert.deepEqual(report.selection.proposed, ["permission_guard"]);
      assert.deepEqual(report.selection.applied, ["pre_response_check"]);
    } finally { await lab.close(); }
  });

  it("preserves partial evidence and stops on diagnosis failure without replay or fallback", async () => {
    const lab = await startOfflineShop(agent(), null);
    try {
      const report = await runShopDemo(options(lab));
      assert.equal(report.exit_code, 1);
      assert.equal(report.attempts.length, 2);
      assert.deepEqual(report.errors, [{ stage: "diagnosis", code: "diagnosis_unavailable" }]);
      assert.equal(report.verdict.fix_verified, null);
      assert.deepEqual(report.selection.applied, []);
      assert.equal((await lab.store.getTrace(report.attempts[1].trace!.trace_id))?.diagnosis, null);
    } finally { await lab.close(); }
  });

  it("stops after a failed clean baseline without buying a diagnosis or injecting a fault", async () => {
    const fixture = agent();
    fixture.tasks[0].success_test.checks[1].params = { product_id: "SKU-DOES-NOT-EXIST" };
    let diagnoses = 0;
    const lab = await startOfflineShop(fixture, { complete: async () => {
      diagnoses++; throw new Error("must not diagnose an invalid baseline");
    } });
    try {
      const report = await runShopDemo(options(lab));
      assert.equal(report.exit_code, 2);
      assert.equal(report.attempts.length, 1);
      assert.equal(report.attempts[0].passed, false);
      assert.equal(report.diagnosis.status, "skipped");
      assert.equal(diagnoses, 0);
      assert.equal(report.verdict.fix_verified, null);
      assert.match(report.skipped.join(" "), /baseline did not pass/);
    } finally { await lab.close(); }
  });

  it("retains an infrastructure-error Run without treating its missing Trace as verifier failure", async () => {
    const fixture = agent();
    const lab = await startOfflineShop(fixture);
    const proxy: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith("/runs") && init?.method === "POST") {
        const data = await response.json() as { results: Array<{ run: { status: string }; trace: unknown }> };
        data.results[0].run.status = "error";
        data.results[0].trace = null;
        return Response.json(data);
      }
      return response;
    };
    try {
      const report = await runShopDemo(options(lab), proxy);
      assert.equal(report.exit_code, 1);
      assert.equal(report.errors[0].code, "harness_error");
      assert.equal(report.attempts[0].run?.status, "error");
      assert.equal(report.attempts[0].trace, null);
      assert.equal(report.attempts[0].passed, null);
      assert.equal(report.verdict.fix_verified, null);
    } finally { await lab.close(); }
  });

  it("live mode refuses an unconfigured model before any run and does not switch to offline", async () => {
    const lab = await startOfflineShop(agent(), null);
    try {
      const report = await runShopDemo({ ...options(lab), mode: "live" });
      assert.equal(report.mode, "live");
      assert.equal(report.exit_code, 1);
      assert.deepEqual(report.errors, [{ stage: "preflight", code: "live_diagnosis_not_configured" }]);
      assert.equal((await lab.store.listRuns()).length, 0);
    } finally { await lab.close(); }
  });

  it("rejects a library world and an incomplete scenario before resetting any world", async () => {
    for (const library of [true, false]) {
      const input = agent();
      if (library) input.world = { kind: "library", base_url: "http://unused.invalid" };
      const lab = await startOfflineShop(input);
      try {
        const settings = options(lab);
        if (!library) settings.scenario.clean_control_task_ids = [settings.scenario.task_id];
        const report = await runShopDemo(settings);
        assert.equal(report.exit_code, 1);
        assert.equal(report.errors[0].code, library ? "unsupported_non_shop_world" : "incomplete_control_suite");
        assert.equal((await lab.store.listRuns()).length, 0);
      } finally { await lab.close(); }
    }
  });

  it("detects an agent edited between arms and never modifies it to restore the scenario", async () => {
    const lab = await startOfflineShop(agent());
    let edited = false;
    const proxy: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!edited && String(url).endsWith("/runs") && init?.method === "POST") {
        edited = true;
        const current = (await lab.agents.get(lab.agent.agent_id))!;
        await lab.agents.replace(current.agent_id, { ...current, name: "changed by another developer" });
      }
      return response;
    };
    try {
      const report = await runShopDemo(options(lab), proxy);
      assert.equal(report.exit_code, 1);
      assert.equal(report.errors[0].code, "agent_changed");
      assert.equal((await lab.store.listRuns()).length, 1);
      assert.equal((await lab.agents.get(lab.agent.agent_id))?.name, "changed by another developer");
      assert.notEqual(report.verdict.fix_verified, true);
    } finally { await lab.close(); }
  });

  it("keeps busy distinct from a verifier failure and keeps missing controls inconclusive", async () => {
    const lab = await startOfflineShop(agent());
    let runCount = 0;
    const proxy: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/runs") && init?.method === "POST" && ++runCount === 5) {
        return Response.json({ error: "world_busy" }, { status: 409 });
      }
      return fetch(url, init);
    };
    try {
      const report = await runShopDemo(options(lab), proxy);
      assert.equal(report.errors[0].code, "world_busy");
      assert.equal(report.exit_code, 1);
      assert.equal(report.verdict.fix_verified, null);
      assert.equal(report.verdict.regressions_complete, false);
      assert.deepEqual(report.attempts.slice(0, 3).map(arm => arm.passed), [true, false, true]);
      assert.match(renderShopDemoMarkdown(report), /world_busy/);
    } finally { await lab.close(); }
  });

  it("rejects a control contaminated by an extra fault instead of claiming verification", async () => {
    const lab = await startOfflineShop(agent());
    const proxy: typeof fetch = async (url, init) => {
      // Explicit test-only perturbation: ask the existing injector to corrupt
      // the clean treated cart call. No model or verifier result is fabricated.
      if (String(url).endsWith("/runs") && init?.body) {
        const body = JSON.parse(init.body as string);
        if (body.phase === "after_fix" && body.injection === null && body.task_ids[0] === "add-mugs") {
          body.injection = rawScenario.test_expectations.regression_probe.injection_plan;
          return fetch(url, { ...init, body: JSON.stringify(body) });
        }
      }
      return fetch(url, init);
    };
    try {
      const report = await runShopDemo(options(lab), proxy);
      // The extra fault is rejected as a configuration mismatch, not accepted
      // as a valid clean-control result. verifyFix's pure matrix covers the
      // case of an otherwise comparable control that genuinely regresses.
      assert.equal(report.exit_code, 1);
      assert.equal(report.errors[0].code, "experiment_configuration_mismatch");
      assert.notEqual(report.verdict.fix_verified, true);
      assert.ok(report.attempts.some(arm => arm.trace?.outcome.verifier.checks.some(check => check.name === "cart_contains" && !check.passed)));
    } finally { await lab.close(); }
  });
});

describe("shop CLI and artifacts", { concurrency: false }, () => {
  it("requires explicit mode, validates flags and never accepts an external target in offline mode", () => {
    for (const argv of [[], ["--mode", "auto"], ["--mode", "live"], ["--mode", "offline", "--backend-url", "http://localhost"],
      ["--mode", "offline", "--fix", "invented"], ["--mode", "offline", "--timeout-ms", "0"],
      ["--mode", "offline", "--unknown", "x"], ["--mode", "offline", "--mode", "live"]]) {
      assert.throws(() => parseDemoArgs(argv));
    }
    assert.equal(parseDemoArgs(["--", "--mode", "offline"]).mode, "offline");
    assert.throws(() => parseShopScenario({ ...rawScenario, schema_version: 2 }));
  });

  it("runs the real offline CLI twice, writes matching reports, preserves old files, ignores a supplied xAI key", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "shop-cli-test-"));
    const previous = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "offline-test-key-must-not-be-used";
    let stdout = "", stderr = "";
    const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
    try {
      for (let i = 0; i < 2; i++) {
        const exit = await demoShopCli(["--mode", "offline", "--output", dir], io);
        assert.equal(exit, 0, stderr);
      }
      const entries = await readdir(dir);
      assert.equal(entries.filter(name => name.endsWith(".json")).length, 2);
      assert.equal(entries.filter(name => name.endsWith(".md")).length, 2);
      const outputs = stdout.trim().split("\n").map(line => JSON.parse(line));
      assert.notEqual(outputs[0].json, outputs[1].json);
      const report = JSON.parse(await readFile(outputs[0].json, "utf8")) as DemoReport;
      assert.equal(report.mode, "offline");
      assert.equal(report.verdict.fix_verified, true);
      assert.equal(await readFile(outputs[0].markdown, "utf8"), renderShopDemoMarkdown(report));
      await assert.rejects(writeDemoReports(report, dir), { code: "EEXIST" });
      assert.equal(stderr, "");
      assert.doesNotMatch(await readFile(outputs[0].json, "utf8"), /offline-test-key-must-not-be-used/);
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
