import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CONTRACT_VERSION, FIX_KINDS, GROK_POLL_INTERVAL_MS, type Agent, type FixKind, type InjectionPlan, type Run, type RunPhase, type Trace } from "@mesa/shared";
import { validateAgent, validateRun, validateTrace } from "@mesa/shared/validate";
import { verifyFix, type FixVerdict } from "../replay/verification.js";
import { record, type ShopScenario } from "./scenario.js";

export interface DemoOptions {
  mode: "live" | "offline";
  backendUrl: string;
  agentId: string;
  scenario: ShopScenario;
  /** Optional separately reachable probe URL for the backend-configured diagnosis service. */
  diagnosisServiceUrl?: string;
  manualFixes?: readonly FixKind[];
  timeoutMs?: number;
  code: { client_commit: string | null; dirty: boolean };
}

export interface DemoAttempt {
  role: "baseline" | "injected" | "after_fix" | "control_baseline" | "control_treated";
  task_id: string;
  status: "ran" | "error";
  passed: boolean | null;
  error: string | null;
  run: Run | null;
  trace: Trace | null;
  permissions: string[];
  driver: "http";
}

export interface DemoReport {
  schema_version: 1;
  report_id: string;
  mode: "live" | "offline";
  started_at: string;
  ended_at: string;
  code: DemoOptions["code"] & { backend_commit: null; planner_commit: null };
  backend_url: string;
  scenario: ShopScenario;
  configuration: { agent: Agent; agent_sha256: string; runtime_url: string; diagnosis_probe_url: string; mock_url: string | null } | null;
  diagnosis: { status: "pending" | "completed" | "error" | "skipped"; trace: Trace | null;
    cached: boolean | null; backend_wall_ms: number | null; model: null; usage: null; error: string | null };
  selection: { source: "diagnosis" | "offline_model" | "manual" | "none"; proposed: FixKind[]; applied: FixKind[] };
  attempts: DemoAttempt[];
  skipped: string[];
  errors: Array<{ stage: string; code: string }>;
  verdict: FixVerdict;
  exit_code: 0 | 1 | 2;
}

class DemoError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function httpBase(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new DemoError("invalid_service_url"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new DemoError("invalid_service_url");
  }
  return url.href.replace(/\/+$/, "");
}

function loopback(value: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(value).hostname);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function planIdentity(plan: InjectionPlan | null) {
  if (plan === null) return null;
  const { step_id: _generated, ...groundTruth } = plan.ground_truth;
  return { ...plan, ground_truth: groundTruth };
}

function fixes(value: unknown): FixKind[] {
  if (!Array.isArray(value) || value.some(fix => !(FIX_KINDS as readonly unknown[]).includes(fix))) {
    throw new DemoError("invalid_fix_list");
  }
  return [...new Set(value)] as FixKind[];
}

export async function runShopDemo(options: DemoOptions, fetchImpl: typeof fetch = fetch): Promise<DemoReport> {
  const report: DemoReport = { schema_version: 1, report_id: `shop-${randomUUID()}`, mode: options.mode,
    started_at: new Date().toISOString(), ended_at: "", code: { ...options.code, backend_commit: null, planner_commit: null },
    backend_url: options.backendUrl, scenario: structuredClone(options.scenario), configuration: null,
    diagnosis: { status: "pending", trace: null, cached: null, backend_wall_ms: null, model: null, usage: null, error: null },
    selection: { source: "none", proposed: [], applied: [] }, attempts: [], skipped: [], errors: [],
    verdict: verifyFix({ baseline: null, before: null, after: null, expectedControls: options.scenario.clean_control_task_ids, controls: [] }), exit_code: 2 };
  let stage = "preflight";
  let baseline: DemoAttempt | undefined, before: DemoAttempt | undefined, after: DemoAttempt | undefined;
  const controls = new Map<string, { taskId: string; baseline: boolean | null; treated: boolean | null }>();
  const timeoutMs = options.timeoutMs ?? 150_000;

  async function request(url: string, body?: unknown) {
    let response: Response;
    let data: unknown;
    try {
      response = await fetchImpl(url, { method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
      data = await response.json();
    } catch { throw new DemoError("transport_or_response_error"); }
    if (!response.ok) {
      const code = record(data) && typeof data.error === "string" && /^[a-z0-9_]+$/.test(data.error) ? data.error : "http_error";
      throw new DemoError(code);
    }
    return { data, response };
  }

  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new DemoError("invalid_timeout");
    const backendUrl = httpBase(options.backendUrl);
    report.backend_url = backendUrl;
    const { data: health } = await request(`${backendUrl}/health`);
    if (!record(health) || health.status !== "ok" || health.contract_version !== CONTRACT_VERSION) throw new DemoError("incompatible_backend");
    const initialHealth = health;
    const agentPath = `${backendUrl}/agents/${encodeURIComponent(options.agentId)}`;
    const loaded = validateAgent((await request(agentPath)).data);
    if (!loaded.ok) throw new DemoError("invalid_agent_document");
    const agent = structuredClone(loaded.value);
    if (agent.world !== undefined || agent.tasks.some(task => task.setup.library !== undefined)) throw new DemoError("unsupported_non_shop_world");
    const runtime = httpBase(agent.instance.base_url);
    if (runtime !== httpBase(agent.test_instance.base_url)) throw new DemoError("different_runtime_endpoints");
    if (!loopback(backendUrl) && loopback(runtime)) throw new DemoError("loopback_runtime_on_remote_backend");
    const allIds = agent.tasks.map(task => task.task_id).sort();
    if (!isDeepStrictEqual(allIds, [...report.scenario.clean_control_task_ids].sort()) || !allIds.includes(report.scenario.task_id)) {
      throw new DemoError("incomplete_control_suite");
    }
    const diagnosisUrl = httpBase(options.diagnosisServiceUrl ?? runtime);
    const { data: runtimeHealth } = await request(`${runtime}/health`);
    if (!record(runtimeHealth) || (runtimeHealth.status !== "ok" && runtimeHealth.ok !== true) ||
        (runtimeHealth.contract_version !== undefined && runtimeHealth.contract_version !== CONTRACT_VERSION)) throw new DemoError("incompatible_runtime");
    const diagnosisHealth = diagnosisUrl === runtime ? runtimeHealth : (await request(`${diagnosisUrl}/health`)).data;
    if (!record(diagnosisHealth) || diagnosisHealth.status !== "ok" ||
        (options.mode === "live" && diagnosisHealth.grok_configured !== true)) throw new DemoError("live_diagnosis_not_configured");
    const { data: catalog } = await request(`${backendUrl}/faults`);
    const plan = report.scenario.injection_plan;
    if (!record(catalog) || !Array.isArray(catalog.faults) || !catalog.faults.some(entry => record(entry) &&
        entry.code === plan.ground_truth.code && entry.category === plan.ground_truth.category)) throw new DemoError("unknown_scenario_fault");
    const appliedManual = options.manualFixes === undefined ? undefined : fixes(options.manualFixes);
    report.configuration = { agent, agent_sha256: createHash("sha256").update(canonical(agent)).digest("hex"),
      runtime_url: runtime, diagnosis_probe_url: diagnosisUrl, mock_url: typeof health.mock_base_url === "string" ? health.mock_base_url : null };

    async function assertFrozen() {
      const current = validateAgent((await request(agentPath)).data);
      if (!current.ok || !isDeepStrictEqual(current.value, agent)) throw new DemoError("agent_changed");
      const { data: now } = await request(`${backendUrl}/health`);
      if (!record(now) || now.contract_version !== initialHealth.contract_version || now.mock_base_url !== initialHealth.mock_base_url) throw new DemoError("backend_configuration_changed");
    }

    async function followAgentJob(
      post: typeof request,
      url: string,
      body: unknown,
      waitMs: number,
    ): Promise<{ data: unknown; response: Response }> {
      const first = await post(url, body);
      if (!record(first.data) || first.data.status !== "accepted" || typeof first.data.poll !== "string") return first;
      const deadline = Date.now() + (typeof first.data.deadline_ms === "number" ? first.data.deadline_ms : waitMs);
      const pollUrl = first.data.poll.startsWith("http") ? first.data.poll : `${backendUrl}${first.data.poll}`;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, GROK_POLL_INTERVAL_MS));
        const polled = await post(pollUrl);
        if (!record(polled.data) || polled.data.status === "running") continue;
        if (polled.data.status === "done") return { data: polled.data.body, response: polled.response };
        throw new DemoError(typeof polled.data.error === "string" ? polled.data.error : "grok_run_failed");
      }
      throw new DemoError("grok_job_timeout");
    }

    async function attempt(role: DemoAttempt["role"], taskId: string, phase: RunPhase, injection: InjectionPlan | null, treatment: FixKind[] = [], parent?: string) {
      const row: DemoAttempt = { role, task_id: taskId, status: "error", passed: null, error: null, run: null, trace: null, permissions: [], driver: "http" };
      report.attempts.push(row);
      try {
        await assertFrozen();
        const { data } = await followAgentJob(request, `${backendUrl}/runs`, { agent_id: agent.agent_id, task_ids: [taskId], phase,
          driver: "http", injection, ...(treatment.length ? { fix_kinds: treatment } : {}), ...(parent ? { parent_run_id: parent } : {}) }, timeoutMs);
        if (!record(data) || !Array.isArray(data.results) || data.results.length !== 1 || !record(data.results[0])) throw new DemoError("invalid_run_response");
        const result = data.results[0];
        const run = validateRun(result.run);
        if (!run.ok) throw new DemoError("invalid_run_document");
        row.run = run.value;
        if (run.value.status === "error") throw new DemoError("harness_error");
        const trace = validateTrace(result.trace);
        if (!trace.ok) throw new DemoError("invalid_trace_document");
        row.trace = trace.value;
        if (trace.value.status === "timeout" || trace.value.status === "error") throw new DemoError("harness_timeout_or_error");
        const task = agent.tasks.find(task => task.task_id === taskId)!;
        if (result.driver !== "http" || !isDeepStrictEqual(result.permissions, task.setup.permissions) ||
            run.value.agent_id !== agent.agent_id || run.value.task_id !== taskId || run.value.phase !== phase ||
            !isDeepStrictEqual(run.value.fix_kinds, treatment) || (run.value.parent_run_id ?? undefined) !== parent ||
            !isDeepStrictEqual(planIdentity(run.value.injection_plan), injection) ||
            trace.value.agent_id !== agent.agent_id || trace.value.run_id !== run.value.run_id || trace.value.task_id !== taskId ||
            !run.value.trace_ids.includes(trace.value.trace_id) || trace.value.outcome.success !== trace.value.outcome.verifier.passed) {
          throw new DemoError("experiment_configuration_mismatch");
        }
        row.permissions = [...task.setup.permissions];
        const savedRun = (await request(`${backendUrl}/runs/${encodeURIComponent(run.value.run_id)}`)).data;
        const savedTrace = (await request(`${backendUrl}/traces/${encodeURIComponent(trace.value.trace_id)}`)).data;
        if (!isDeepStrictEqual(savedRun, run.value) || !isDeepStrictEqual(savedTrace, trace.value)) throw new DemoError("persisted_result_mismatch");
        await assertFrozen();
        row.status = "ran";
        row.passed = trace.value.outcome.verifier.passed;
        return row;
      } catch (error) {
        row.error = error instanceof DemoError ? error.code : "unexpected_error";
        throw error;
      }
    }

    stage = "baseline";
    baseline = await attempt("baseline", report.scenario.task_id, "baseline", null);
    if (!baseline.passed) {
      report.skipped.push("Injected, diagnosis, replay and controls: primary baseline did not pass.");
      report.diagnosis.status = "skipped";
    } else {
      stage = "injected";
      before = await attempt("injected", report.scenario.task_id, "injected", plan);
      stage = "diagnosis";
      const original = before.trace!;
      const diagnosedPath = `${backendUrl}/traces/${encodeURIComponent(original.trace_id)}`;
      const diagnosed = await request(`${diagnosedPath}/diagnose`, {});
      const parsed = validateTrace(diagnosed.data);
      if (!parsed.ok || parsed.value.diagnosis === null || !isDeepStrictEqual({ ...parsed.value, diagnosis: null }, { ...original, diagnosis: null })) throw new DemoError("invalid_diagnosis_response");
      if (!isDeepStrictEqual((await request(diagnosedPath)).data, parsed.value)) throw new DemoError("diagnosis_not_persisted");
      report.diagnosis = { status: "completed", trace: parsed.value,
        cached: diagnosed.response.headers.get("x-diagnosis-cached") === "true",
        backend_wall_ms: diagnosed.response.headers.has("x-diagnosis-duration-ms") ? Number(diagnosed.response.headers.get("x-diagnosis-duration-ms")) : null,
        model: null, usage: null, error: null };
      report.selection.proposed = fixes(parsed.value.diagnosis.proposed_fixes);
      report.selection.applied = appliedManual ?? [...report.selection.proposed];
      report.selection.source = appliedManual !== undefined ? "manual" : options.mode === "offline" ? "offline_model" : "diagnosis";
      if (report.selection.applied.length === 0) {
        report.skipped.push("Replay and controls: no fixes were selected; no category/ground-truth fallback.");
      } else {
        stage = "after_fix";
        after = await attempt("after_fix", report.scenario.task_id, "after_fix", plan, report.selection.applied, before.run!.run_id);
        for (const taskId of report.scenario.clean_control_task_ids) {
          const control = { taskId, baseline: null as boolean | null, treated: null as boolean | null };
          controls.set(taskId, control);
          stage = `control_baseline:${taskId}`;
          const clean = await attempt("control_baseline", taskId, "baseline", null);
          control.baseline = clean.passed;
          stage = `control_treated:${taskId}`;
          const treated = await attempt("control_treated", taskId, "after_fix", null, report.selection.applied, clean.run!.run_id);
          control.treated = treated.passed;
        }
      }
    }
  } catch (error) {
    const code = error instanceof DemoError ? error.code : "unexpected_error";
    report.errors.push({ stage, code });
    if (stage === "diagnosis") { report.diagnosis.status = "error"; report.diagnosis.error = code; }
    else if (report.diagnosis.status === "pending") report.diagnosis.status = "skipped";
  }
  report.verdict = verifyFix({ baseline: baseline?.passed ?? null, before: before?.passed ?? null, after: after?.passed ?? null,
    expectedControls: report.scenario.clean_control_task_ids, controls: [...controls.values()] });
  report.exit_code = report.errors.length ? 1 : report.verdict.fix_verified === true ? 0 : 2;
  report.ended_at = new Date().toISOString();
  return report;
}
