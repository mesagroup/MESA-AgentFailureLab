/**
 * Build the harness half of the eval set.
 *
 * Uses the merged backend: in-process mock shop, `driver: "scripted"`, and a
 * catalog fault (`runTasks`). It does not call the reference agent from open
 * PR #21. That agent is still the source of traces where the model itself
 * picks the wrong tool; those files are not on main, and this script does not
 * copy them.
 *
 * Loopback only. Re-running changes trace ids and timestamps because the
 * harness draws them with `randomUUID` and `Date.now`. The manifest records
 * the ground-truth source by reading `fault` after the run. The evaluator
 * reads that same object later and does not send it to Grok.
 */
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTrace } from "@mesa/shared/validate";
import { FAULT_CATALOG } from "../../backend/src/injector/catalog.js";
import { runTasks } from "../../backend/src/harness/runner.js";
import { createHttpMockClient } from "../../backend/src/mock/client.js";
import { MemoryStore } from "../../backend/src/persistence/memory.js";
import { loadReferenceAgent } from "../../backend/src/reference-agent.js";
import { buildApp } from "../../../services/mock-shop/src/app.js";
import {
  DATASET_PLAN,
  GENERATED_TRACE_DIR,
  MANIFEST_PATH,
  generatedTraceRelativePath,
  type DatasetPlanEntry,
} from "../src/eval/dataset-plan.js";
import type { Manifest, ManifestCase } from "../src/eval/load-dataset.js";
import { readGroundTruth } from "../src/eval/rules.js";
import { repoRoot } from "../src/eval/repo-root.js";

async function main(): Promise<void> {
  const root = repoRoot(import.meta.url);
  const shop = buildApp({ logger: false });
  const baseUrl = await shop.listen({ port: 0, host: "127.0.0.1" });
  const generatedDir = path.join(root, GENERATED_TRACE_DIR);
  mkdirSync(generatedDir, { recursive: true });
  try {
    const mock = createHttpMockClient(baseUrl);
    const store = new MemoryStore();
    const agent = loadReferenceAgent();
    const cases: ManifestCase[] = [];
    for (const entry of DATASET_PLAN) {
      if (entry.origin === "fixture") {
        cases.push(fixtureCase(root, entry));
        continue;
      }
      cases.push(await harnessCase({ root, entry, agent, store, mock, baseUrl }));
    }
    deleteStale(generatedDir, cases);
    const manifest: Manifest = { schema_version: 1, cases };
    writeFileSync(path.join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await shop.close();
  }
}

function fixtureCase(root: string, entry: Extract<DatasetPlanEntry, { origin: "fixture" }>): ManifestCase {
  const absolute = path.join(root, entry.trace);
  const parsed: unknown = JSON.parse(readFileSync(absolute, "utf8"));
  const validated = validateTrace(parsed);
  if (!validated.ok) {
    throw new Error(`${entry.trace} failed trace schema: ${validated.errors.join("; ")}`);
  }
  const ground = readGroundTruth(validated.value);
  if (!ground.ok) {
    throw new Error(`${entry.id} is not a scored fixture (${ground.reason}).`);
  }
  return {
    id: entry.id,
    trace: entry.trace,
    origin: "fixture",
    ground_truth_source: ground.truth.source,
  };
}

async function harnessCase(input: {
  root: string;
  entry: Extract<DatasetPlanEntry, { origin: "harness-scripted" }>;
  agent: ReturnType<typeof loadReferenceAgent>;
  store: MemoryStore;
  mock: ReturnType<typeof createHttpMockClient>;
  baseUrl: string;
}): Promise<ManifestCase> {
  const catalog = FAULT_CATALOG.find((item) => item.code === input.entry.code);
  if (catalog === undefined) {
    throw new Error(`${input.entry.id} code ${input.entry.code} is not in FAULT_CATALOG.`);
  }
  if (catalog.category !== input.entry.category) {
    throw new Error(
      `${input.entry.id} category ${input.entry.category} does not match catalog ${catalog.category}.`,
    );
  }
  const injection: Record<string, unknown> = {
    fault: catalog.fault,
    target: input.entry.target,
    ground_truth: { category: input.entry.category, code: input.entry.code },
  };
  const [result] = await runTasks({
    agent: input.agent,
    store: input.store,
    mock: input.mock,
    mockBaseUrl: input.baseUrl,
    phase: "injected",
    taskIds: [input.entry.task_id],
    driver: "scripted",
    grantCancel: true,
    timeoutMs: 5_000,
    injection,
  });
  if (result === undefined || result.trace === null) {
    const message = result?.run.error_message ?? "no trace";
    throw new Error(`${input.entry.id} produced no trace (${message}).`);
  }
  const label = result.trace.fault.labels[0];
  if (result.trace.fault.labels.length !== 1 || label === undefined || label.code !== input.entry.code) {
    throw new Error(`${input.entry.id} labels were ${JSON.stringify(result.trace.fault.labels)}.`);
  }
  if (label.category !== input.entry.category) {
    throw new Error(`${input.entry.id} label category was ${label.category}.`);
  }
  const relative = generatedTraceRelativePath(input.entry.id);
  writeFileSync(path.join(input.root, relative), `${JSON.stringify(result.trace, null, 2)}\n`);
  const ground = readGroundTruth(result.trace);
  if (!ground.ok) {
    throw new Error(`${input.entry.id} trace is not scored (${ground.reason}).`);
  }
  return {
    id: input.entry.id,
    trace: relative,
    origin: "harness-scripted",
    ground_truth_source: ground.truth.source,
  };
}

function deleteStale(generatedDir: string, cases: readonly ManifestCase[]): void {
  const keep = new Set(
    cases.filter((item) => item.origin === "harness-scripted").map((item) => path.basename(item.trace)),
  );
  for (const name of readdirSync(generatedDir)) {
    if (!name.endsWith(".json") || keep.has(name)) {
      continue;
    }
    unlinkSync(path.join(generatedDir, name));
  }
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "generate-dataset failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
