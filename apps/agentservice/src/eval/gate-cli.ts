import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGrok } from "./cli.js";
import { MANIFEST_PATH } from "./dataset-plan.js";
import { evaluateDataset } from "./evaluate.js";
import {
  BASELINE_PATH,
  applyHitDrop,
  compareToBaseline,
  formatGateReport,
  isGatedMetricId,
  loadBaseline,
  metricsFromSummary,
  writeBaselineCounts,
  type GatedMetricId,
} from "./gate.js";
import { repoRoot } from "./repo-root.js";

interface GateArgs {
  write: boolean;
  baseline: string | null;
  simulateDrop: GatedMetricId | null;
}

export async function runGate(input: {
  repoRoot: string;
  baselinePath: string;
  write: boolean;
  simulateDrop: GatedMetricId | null;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}): Promise<number> {
  const stdout = input.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = input.stderr ?? ((text: string) => process.stderr.write(text));
  if (input.write && input.simulateDrop !== null) {
    stderr("eval gate: --write cannot be combined with --simulate-drop.\n");
    return 1;
  }
  // Empty key, and no other diagnosis settings. A key in the process environment
  // must not turn this command into a live Grok call.
  const grok = resolveGrok({ fake: false }, { XAI_API_KEY: "" });
  if (grok.mode !== "skipped") {
    stderr("eval gate: Grok must be skipped.\n");
    return 1;
  }
  const report = await evaluateDataset({
    repoRoot: input.repoRoot,
    manifestPath: MANIFEST_PATH,
    grok,
  });
  const committed = loadBaseline(input.baselinePath);
  const measured = metricsFromSummary(report.methods.baseline);
  if (input.write) {
    writeBaselineCounts(input.baselinePath, committed, measured);
    const written = loadBaseline(input.baselinePath);
    const lines = [`eval gate: wrote ${displayPath(input.repoRoot, input.baselinePath)}`];
    for (const metric of written.metrics) {
      lines.push(`- ${metric.id} (${metric.scoreboard}): ${metric.hits}/${metric.total}`);
    }
    lines.push(`grok: skipped (${grok.reason})`);
    stdout(`${lines.join("\n")}\n`);
    return 0;
  }
  const fresh = input.simulateDrop === null ? measured : applyHitDrop(measured, input.simulateDrop);
  const verdict = compareToBaseline(committed, fresh);
  const text = formatGateReport({
    verdict,
    grokReason: grok.reason,
    simulated: input.simulateDrop,
    baselinePath: displayPath(input.repoRoot, input.baselinePath),
  });
  if (verdict.ok) {
    stdout(`${text}\n`);
    return 0;
  }
  stderr(`${text}\n`);
  return 1;
}

function displayPath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative;
}

function parseArgs(argv: readonly string[]): GateArgs {
  const args: GateArgs = { write: false, baseline: null, simulateDrop: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      continue;
    }
    if (token === "--write") {
      args.write = true;
      continue;
    }
    if (token === "--baseline") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--baseline requires a path.");
      }
      args.baseline = value;
      index += 1;
      continue;
    }
    if (token === "--simulate-drop") {
      const value = argv[index + 1];
      if (!isGatedMetricId(value)) {
        throw new Error(
          "--simulate-drop requires category_accuracy, step_accuracy_exact, step_accuracy_tolerance_1, or proposed_fix_hit_rate.",
        );
      }
      args.simulateDrop = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument ${token ?? ""}.`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot(import.meta.url);
  const baselinePath = args.baseline === null ? path.join(root, BASELINE_PATH) : path.resolve(args.baseline);
  process.exitCode = await runGate({
    repoRoot: root,
    baselinePath,
    write: args.write,
    simulateDrop: args.simulateDrop,
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "eval gate failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
