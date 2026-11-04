import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGrokModel } from "../grok/client.js";
import { parseDiagnosisConfig } from "../grok/config.js";
import { MANIFEST_PATH, RESULTS_DIR } from "./dataset-plan.js";
import { FAKE_MODEL_NAME, evaluateDataset, fakeDiagnosisModel, type GrokRun } from "./evaluate.js";
import {
  LIMITS_END,
  LIMITS_START,
  SCOREBOARD_END,
  SCOREBOARD_START,
  renderDetails,
  renderLimits,
  renderScoreboard,
  spliceMarked,
} from "./report.js";
import { repoRoot } from "./repo-root.js";

const SKIPPED_REASON = "XAI_API_KEY is unset";

interface CliArgs {
  fake: boolean;
  readme: boolean;
  outDir: string | null;
  manifest: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot(import.meta.url);
  const grok = resolveGrok(args, process.env);
  const report = await evaluateDataset({
    repoRoot: root,
    manifestPath: args.manifest ?? MANIFEST_PATH,
    grok,
  });
  const outDir = path.resolve(root, args.outDir ?? RESULTS_DIR);
  mkdirSync(outDir, { recursive: true });
  const board = renderScoreboard(report);
  const limits = renderLimits(report);
  const markdown = [
    SCOREBOARD_START,
    board,
    SCOREBOARD_END,
    "",
    LIMITS_START,
    limits,
    LIMITS_END,
    "",
    renderDetails(report),
    "",
  ].join("\n");
  writeFileSync(path.join(outDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(outDir, "latest.md"), markdown);
  if (args.readme) {
    const readmePath = path.join(root, "README.md");
    const withBoard = spliceMarked(readFileSync(readmePath, "utf8"), SCOREBOARD_START, SCOREBOARD_END, board);
    writeFileSync(readmePath, spliceMarked(withBoard, LIMITS_START, LIMITS_END, limits));
  }
  const grokReport = report.methods.grok;
  if (grokReport.mode === "live" && grokReport.errors > 0) {
    process.exitCode = 1;
  }
}

export function resolveGrok(args: { fake: boolean }, env: NodeJS.ProcessEnv): GrokRun {
  if (args.fake) {
    return { mode: "fake", model: fakeDiagnosisModel(), modelName: FAKE_MODEL_NAME };
  }
  const config = parseDiagnosisConfig(env);
  if (config.apiKey === null) {
    return { mode: "skipped", reason: SKIPPED_REASON };
  }
  return {
    mode: "live",
    modelName: config.modelName,
    model: createGrokModel({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    }),
  };
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { fake: false, readme: true, outDir: null, manifest: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      continue;
    }
    if (token === "--fake") {
      args.fake = true;
      continue;
    }
    if (token === "--no-readme") {
      args.readme = false;
      continue;
    }
    if (token === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--out requires a directory.");
      }
      args.outDir = value;
      index += 1;
      continue;
    }
    if (token === "--manifest") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--manifest requires a path.");
      }
      args.manifest = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument ${token ?? ""}.`);
  }
  return args;
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
    const message = error instanceof Error ? error.message : "eval failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
