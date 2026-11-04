import { readFileSync } from "node:fs";
import path from "node:path";
import type { Trace } from "@mesa/shared";
import { validateTrace } from "@mesa/shared/validate";
import type { DatasetPlanEntry } from "./dataset-plan.js";
import {
  GROUND_TRUTH_SOURCES,
  hintsInSteps,
  readGroundTruth,
  type GroundTruthSource,
  type HintId,
  type ScoredTruth,
} from "./rules.js";

export interface ManifestCase {
  id: string;
  trace: string;
  origin: DatasetPlanEntry["origin"];
  ground_truth_source: GroundTruthSource;
}

export interface Manifest {
  schema_version: 1;
  cases: ManifestCase[];
}

export interface LoadedCase {
  id: string;
  origin: DatasetPlanEntry["origin"];
  relative_path: string;
  trace: Trace;
  truth: ScoredTruth;
  hints: readonly HintId[];
}

export function loadDataset(repoRoot: string, manifestPath: string): LoadedCase[] {
  const absoluteManifest = path.resolve(repoRoot, manifestPath);
  const manifest = parseManifest(readJson(absoluteManifest));
  const seen = new Set<string>();
  const loaded: LoadedCase[] = [];
  for (const entry of manifest.cases) {
    if (seen.has(entry.id)) {
      throw new Error(`Manifest repeats id ${entry.id}`);
    }
    seen.add(entry.id);
    const absoluteTrace = resolveInside(repoRoot, entry.trace);
    const validated = validateTrace(readJson(absoluteTrace));
    if (!validated.ok) {
      throw new Error(`${entry.trace} failed trace schema: ${validated.errors.join("; ")}`);
    }
    const trace = validated.value;
    assertStepLayout(entry.id, trace);
    const ground = readGroundTruth(trace);
    if (!ground.ok) {
      throw new Error(`${entry.id} is not a scored trace (${ground.reason}).`);
    }
    if (ground.truth.source !== entry.ground_truth_source) {
      throw new Error(
        `${entry.id} manifest source ${entry.ground_truth_source} does not match ${ground.truth.source} on the trace.`,
      );
    }
    if (!trace.steps.some((step) => step.step_id === ground.truth.step_id)) {
      throw new Error(`${entry.id} label step ${ground.truth.step_id} is not on the trace.`);
    }
    loaded.push({
      id: entry.id,
      origin: entry.origin,
      relative_path: entry.trace,
      trace,
      truth: ground.truth,
      hints: hintsInSteps(trace.steps),
    });
  }
  return loaded;
}

export function parseManifest(value: unknown): Manifest {
  if (!isRecord(value)) {
    throw new Error("Manifest is not a JSON object.");
  }
  if (value.schema_version !== 1) {
    throw new Error("Manifest schema_version must be 1.");
  }
  if (!Array.isArray(value.cases)) {
    throw new Error("Manifest cases must be an array.");
  }
  const cases: ManifestCase[] = [];
  for (const item of value.cases) {
    cases.push(parseManifestCase(item));
  }
  return { schema_version: 1, cases };
}

function parseManifestCase(value: unknown): ManifestCase {
  if (!isRecord(value)) {
    throw new Error("Manifest case is not an object.");
  }
  const id = value.id;
  const trace = value.trace;
  const origin = value.origin;
  const source = value.ground_truth_source;
  if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error("Manifest case id must be kebab-case.");
  }
  if (typeof trace !== "string" || !trace.endsWith(".json")) {
    throw new Error(`${id} trace path must be a relative JSON file.`);
  }
  if (origin !== "fixture" && origin !== "harness-scripted") {
    throw new Error(`${id} origin must be fixture or harness-scripted.`);
  }
  if (!isGroundTruthSource(source)) {
    throw new Error(`${id} ground_truth_source must be ${GROUND_TRUTH_SOURCES.join(" or ")}.`);
  }
  return { id, trace, origin, ground_truth_source: source };
}

function assertStepLayout(id: string, trace: Trace): void {
  const seen = new Set<string>();
  for (let position = 0; position < trace.steps.length; position += 1) {
    const step = trace.steps[position];
    if (step === undefined) {
      throw new Error(`${id} is missing step ${position}.`);
    }
    if (seen.has(step.step_id)) {
      throw new Error(`${id} repeats step_id ${step.step_id}.`);
    }
    seen.add(step.step_id);
    if (step.index !== position) {
      throw new Error(`${id} step ${step.step_id} index ${step.index} is not position ${position}.`);
    }
  }
}

function resolveInside(root: string, relative: string): string {
  if (relative.startsWith("/") || relative.includes("..") || relative.includes("\\")) {
    throw new Error(`Trace path escapes the repo: ${relative}`);
  }
  const absolute = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) {
    throw new Error(`Trace path escapes the repo: ${relative}`);
  }
  return absolute;
}

function readJson(file: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return parsed;
}

function isGroundTruthSource(value: unknown): value is GroundTruthSource {
  return value === "fault.labels" || value === "fault.attacker";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
