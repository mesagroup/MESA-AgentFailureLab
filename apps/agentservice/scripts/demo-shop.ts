import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIX_KINDS, type FixKind } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";
import { parseShopScenario } from "../src/demo-shop/scenario.js";
import { runShopDemo, type DemoReport } from "../src/demo-shop/run.js";
import { renderShopDemoMarkdown } from "../src/demo-shop/report.js";

const HELP = `Usage: pnpm demo:shop -- --mode offline|live [options]
  --mode offline              private loopback stack, explicit offline model, no xAI
  --mode live                 existing services only; requires --backend-url and --agent-id
  --backend-url URL           backend URL (live only)
  --agent-id ID               existing registered Agent (live only)
  --diagnosis-service-url URL  health probe URL for backend-configured agentservice (live)
  --scenario FILE             scenario manifest (default: shop-readback-v1)
  --task-id ID                explicit main-task override, must be in the control suite
  --fix ID[,ID]               explicit HUMAN intervention, never a diagnostic fallback
  --timeout-ms N              HTTP deadline, 1..300000 (default 150000)
  --output DIRECTORY          unique JSON/Markdown reports (default: ./demo-results)
Exit: 0 verified, 1 infrastructure/preflight/output error, 2 not verified/inconclusive, 64 invalid arguments.
`;

export function parseDemoArgs(argv: readonly string[]) {
  const values = new Map<string, string>();
  const allowed = new Set(["mode", "backend-url", "agent-id", "diagnosis-service-url", "scenario", "task-id", "fix", "timeout-ms", "output"]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") continue;
    const name = argv[i].startsWith("--") ? argv[i].slice(2) : "";
    const value = argv[++i];
    if (!allowed.has(name) || values.has(name) || value === undefined || value.startsWith("--")) throw new Error("invalid_arguments");
    values.set(name, value);
  }
  const mode = values.get("mode");
  if (mode !== "live" && mode !== "offline") throw new Error("explicit_mode_required");
  if (mode === "live" && (!values.get("backend-url") || !values.get("agent-id"))) throw new Error("live_target_required");
  if (mode === "offline" && ["backend-url", "agent-id", "diagnosis-service-url"].some(key => values.has(key))) throw new Error("offline_has_no_external_target");
  const timeoutMs = Number(values.get("timeout-ms") ?? 150_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("invalid_timeout");
  let manualFixes: FixKind[] | undefined;
  if (values.has("fix")) {
    const parsed = values.get("fix")!.split(",").map(value => value.trim());
    if (!parsed.length || parsed.some(value => !(FIX_KINDS as readonly string[]).includes(value))) throw new Error("invalid_fix_list");
    manualFixes = [...new Set(parsed)] as FixKind[];
  }
  return { mode: mode as "live" | "offline", backendUrl: values.get("backend-url"), agentId: values.get("agent-id"),
    diagnosisServiceUrl: values.get("diagnosis-service-url"), manualFixes, timeoutMs,
    taskId: values.get("task-id"), output: path.resolve(values.get("output") ?? fileURLToPath(new URL("../../../demo-results", import.meta.url))),
    scenarioPath: path.resolve(values.get("scenario") ?? fileURLToPath(new URL("../scenarios/shop-readback-v1/scenario.json", import.meta.url))) };
}

export async function writeDemoReports(report: DemoReport, output: string) {
  await mkdir(output, { recursive: true });
  const json = path.join(output, `${report.report_id}.json`), markdown = path.join(output, `${report.report_id}.md`);
  // Unique IDs + exclusive writes: never replace historical or user-owned files.
  await writeFile(json, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  await writeFile(markdown, renderShopDemoMarkdown(report), { flag: "wx" });
  return { json, markdown };
}

function codeVersion() {
  try {
    return { client_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0 };
  } catch { return { client_commit: null, dirty: false }; }
}

export async function demoShopCli(argv: readonly string[], io: { stdout: (text: string) => void; stderr: (text: string) => void } = { stdout: (text: string) => process.stdout.write(text), stderr: (text: string) => process.stderr.write(text) }): Promise<number> {
  if (argv.includes("--help")) { io.stdout(HELP); return 0; }
  let args: ReturnType<typeof parseDemoArgs>;
  try { args = parseDemoArgs(argv); }
  catch (error) { io.stderr(`demo:shop: ${error instanceof Error ? error.message : "invalid_arguments"}\n${HELP}`); return 64; }
  let close: (() => Promise<void>) | undefined;
  try {
    const scenario = parseShopScenario(JSON.parse(await readFile(args.scenarioPath, "utf8")));
    if (args.taskId !== undefined) {
      if (!scenario.clean_control_task_ids.includes(args.taskId)) throw new Error("invalid_task_override");
      scenario.task_id = args.taskId;
    }
    await mkdir(args.output, { recursive: true });
    await access(args.output, constants.W_OK);
    let backendUrl = args.backendUrl, agentId = args.agentId;
    if (args.mode === "offline") {
      const parsed = validateAgent(JSON.parse(await readFile(path.join(path.dirname(args.scenarioPath), scenario.agent_file), "utf8")));
      if (!parsed.ok) throw new Error("invalid_offline_agent_fixture");
      const { startOfflineShop } = await import("./demo-shop-offline.js");
      const lab = await startOfflineShop(parsed.value);
      close = lab.close;
      backendUrl = lab.backendUrl;
      agentId = lab.agent.agent_id;
    }
    const report = await runShopDemo({ mode: args.mode, backendUrl: backendUrl!, agentId: agentId!, scenario,
      diagnosisServiceUrl: args.diagnosisServiceUrl, manualFixes: args.manualFixes, timeoutMs: args.timeoutMs, code: codeVersion() });
    const files = await writeDemoReports(report, args.output);
    io.stdout(JSON.stringify({ mode: report.mode, verdict: report.verdict.status, fix_verified: report.verdict.fix_verified, exit_code: report.exit_code, ...files }) + "\n");
    return report.exit_code;
  } catch {
    io.stderr("demo:shop: scenario_setup_or_report_write_error (no live/offline fallback)\n");
    return 1;
  } finally { await close?.(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  demoShopCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write("demo:shop: cleanup_error\n"); process.exitCode = 1;
  });
}
