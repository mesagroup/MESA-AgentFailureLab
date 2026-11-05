import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIBRARY_OTEL_SCHEMA_B_ID,
  STEP_ROLES,
  STEP_TYPES,
  type Agent,
  type OtelMockChannel,
  type Run,
  type RunStatus,
  type StepRole,
  type StepType,
  type Trace,
  type TraceOutcome,
  type TraceStep,
} from "./types.js";
import type { OtelImportContext, OtelImportResult } from "./otel-import.js";
import { validateOtelLibrarySchemaB, validateRun, validateTrace } from "./validate.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoSharedPrefix = "packages/shared/";
const FORBIDDEN_ATTRIBUTE = /^(lib\.fault|lib\.outcome|fault\.labels|outcome\.verifier)(\.|$)/;

interface LibraryExportDoc {
  schema_hint: string;
  library_export: {
    channel: OtelMockChannel;
    service: "external-library";
    task: string;
    run: string;
    verdict: unknown;
  };
  spans: LibrarySpan[];
}

interface LibrarySpan {
  lib_trace_id: string;
  lib_span_id: string;
  action: string;
  started_at: string;
  ended_at: string;
  lib_attrs: Record<string, unknown>;
}

/**
 * Map one library schema B export onto lab Traces and baseline Runs.
 * Copies `library_export.verdict` onto `outcome`. Sets `fault` to the production mark
 * and `diagnosis` to null. Does not read span status into the verifier.
 * Does not call a collector.
 */
export function remapLibrarySchemaB(data: unknown, ctx: OtelImportContext): OtelImportResult {
  if (ctx.agentId.trim() === "") {
    return { ok: false, errors: ["agentId must be a non-empty string."] };
  }
  const hint = isRecord(data) ? data.schema_hint : undefined;
  if (hint !== LIBRARY_OTEL_SCHEMA_B_ID) {
    return { ok: false, errors: [`schema_hint ${String(hint)} is not ${LIBRARY_OTEL_SCHEMA_B_ID}`] };
  }
  const structural = validateOtelLibrarySchemaB(data);
  if (!structural.ok) return structural;
  const doc = structural.value as LibraryExportDoc;
  const outcome = readOutcome(doc.library_export.verdict, "/library_export/verdict");
  if (!outcome.ok) return { ok: false, errors: [outcome.error] };

  const mappedSteps = mapSpans(doc.spans);
  if (!mappedSteps.ok) return { ok: false, errors: mappedSteps.errors };

  const status = outcome.value.verifier.passed ? "completed" : "failed";
  const trace: Trace = {
    trace_id: mappedSteps.traceId,
    agent_id: ctx.agentId,
    run_id: doc.library_export.run,
    task_id: doc.library_export.task,
    started_at: mappedSteps.startedAt,
    ended_at: mappedSteps.endedAt,
    status,
    steps: mappedSteps.steps,
    outcome: outcome.value,
    totals: totalsOf(mappedSteps.steps),
    fault: { injected: false, labels: [], attacker: { used: false, payload_id: null } },
    diagnosis: null,
  };
  const validated = validateTrace(trace);
  if (!validated.ok) return { ok: false, errors: validated.errors };

  const run: Run = {
    run_id: doc.library_export.run,
    agent_id: ctx.agentId,
    task_id: doc.library_export.task,
    phase: "baseline",
    status: runStatus(validated.value),
    trace_ids: [validated.value.trace_id],
    injection_plan: null,
    fix_kinds: [],
    duration_ms: validated.value.totals.latency_ms,
  };
  const validatedRun = validateRun(run);
  if (!validatedRun.ok) return { ok: false, errors: validatedRun.errors };
  return { ok: true, traces: [validated.value], runs: [validatedRun.value] };
}

/**
 * Read the library seed's prod or test fixture. Uses `otel_mock.sources[].fixture_path`.
 * Does not open a socket and does not call `endpoint`.
 */
export function readLibraryOtelMock(channel: OtelMockChannel): unknown {
  const agent = JSON.parse(
    readFileSync(join(packageRoot, "examples", "agent-library-desk.json"), "utf8"),
  ) as Agent;
  const fixturePath = agent.otel_mock?.sources[channel]?.fixture_path;
  if (typeof fixturePath !== "string" || fixturePath.trim() === "") {
    throw new Error(`agent-library-desk.json otel_mock.sources.${channel}.fixture_path is missing.`);
  }
  return JSON.parse(readFileSync(resolveSharedPath(fixturePath), "utf8")) as unknown;
}

function resolveSharedPath(fixturePath: string): string {
  if (isAbsolute(fixturePath)) return fixturePath;
  if (fixturePath.startsWith(repoSharedPrefix)) {
    return join(packageRoot, fixturePath.slice(repoSharedPrefix.length));
  }
  return join(packageRoot, fixturePath);
}

function readOutcome(value: unknown, path: string): { ok: true; value: TraceOutcome } | { ok: false; error: string } {
  if (!isRecord(value) || !isRecord(value.verifier) || typeof value.success !== "boolean" || typeof value.verifier.passed !== "boolean") {
    return {
      ok: false,
      error: `${path} must include success and verifier.passed. The remap does not invent outcome.verifier.`,
    };
  }
  if (value.success !== value.verifier.passed) {
    return {
      ok: false,
      error: `${path}/success must equal verifier.passed. The remap does not rewrite either field.`,
    };
  }
  return { ok: true, value: value as unknown as TraceOutcome };
}

function mapSpans(
  spans: LibrarySpan[],
): { ok: true; steps: TraceStep[]; traceId: string; startedAt: string; endedAt: string } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const traceIds = new Set(spans.map((span) => span.lib_trace_id));
  if (traceIds.size !== 1) {
    errors.push("/spans must share one lib_trace_id.");
  }
  const ordered = spans
    .map((span, index) => ({ span, index }))
    .sort((left, right) => {
      const start = Date.parse(left.span.started_at) - Date.parse(right.span.started_at);
      if (start !== 0) return start;
      return left.span.lib_span_id.localeCompare(right.span.lib_span_id);
    });
  const seenSpanIds = new Set<string>();
  const steps: TraceStep[] = [];
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = 0;

  ordered.forEach(({ span, index: sourceIndex }, order) => {
    const path = `/spans/${sourceIndex}`;
    if (seenSpanIds.has(span.lib_span_id)) errors.push(`${path}/lib_span_id duplicate lib_span_id ${span.lib_span_id}`);
    seenSpanIds.add(span.lib_span_id);
    for (const key of Object.keys(span.lib_attrs)) {
      if (FORBIDDEN_ATTRIBUTE.test(key)) {
        errors.push(`${path}/lib_attrs/${key} is not accepted. The remap does not read fault labels or a verifier from spans.`);
      }
    }
    const opened = Date.parse(span.started_at);
    const closed = Date.parse(span.ended_at);
    if (Number.isNaN(opened) || Number.isNaN(closed)) {
      errors.push(`${path} started_at and ended_at must be ISO-8601 date-times.`);
      return;
    }
    if (closed < opened) {
      errors.push(`${path}/ended_at must be greater than or equal to started_at.`);
    }
    const step = readStep(span, order, path, span.started_at, Math.max(0, closed - opened));
    if (!step.ok) {
      errors.push(...step.errors);
      return;
    }
    minStart = Math.min(minStart, opened);
    maxEnd = Math.max(maxEnd, closed);
    steps.push(step.value);
  });

  if (errors.length > 0 || steps.length !== spans.length) return { ok: false, errors };
  return {
    ok: true,
    steps,
    traceId: spans[0]!.lib_trace_id,
    startedAt: new Date(minStart).toISOString(),
    endedAt: new Date(maxEnd).toISOString(),
  };
}

function readStep(
  span: LibrarySpan,
  index: number,
  path: string,
  timestamp: string,
  latencyMs: number,
): { ok: true; value: TraceStep } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const attrs = span.lib_attrs;
  const type = attrs["lib.step.kind"];
  const role = attrs["lib.step.actor"];
  if (!isStepType(type)) {
    errors.push(`${path}/lib_attrs/lib.step.kind must be message, tool_call, tool_result, or system.`);
  }
  if (!isStepRole(role)) {
    errors.push(`${path}/lib_attrs/lib.step.actor must be user, assistant, tool, or system.`);
  }
  if (errors.length > 0 || !isStepType(type) || !isStepRole(role)) return { ok: false, errors };

  const tokensIn = readCount(attrs, "lib.usage.tokens_in", path);
  const tokensOut = readCount(attrs, "lib.usage.tokens_out", path);
  const cost = readCost(attrs, path);
  if (!tokensIn.ok) errors.push(tokensIn.error);
  if (!tokensOut.ok) errors.push(tokensOut.error);
  if (!cost.ok) errors.push(cost.error);

  const step: TraceStep = {
    step_id: span.lib_span_id,
    index,
    type,
    timestamp,
    role,
    latency_ms: latencyMs,
    token_usage: {
      input: tokensIn.ok ? tokensIn.value : 0,
      output: tokensOut.ok ? tokensOut.value : 0,
    },
    cost_usd: cost.ok ? cost.value : 0,
  };

  if (type === "message" || type === "system") {
    const content = attrs["lib.step.note"];
    if (typeof content !== "string") {
      errors.push(`${path}/lib_attrs/lib.step.note must be a string for ${type}.`);
    } else {
      step.content = content;
    }
  }
  if (type === "tool_call" || type === "tool_result") {
    step.tool_name = span.action;
    if (type === "tool_call") {
      if (!Object.hasOwn(attrs, "lib.tool.request")) {
        errors.push(`${path}/lib_attrs/lib.tool.request is required for tool_call.`);
      } else {
        step.tool_input = attrs["lib.tool.request"];
      }
    } else if (!Object.hasOwn(attrs, "lib.tool.response")) {
      errors.push(`${path}/lib_attrs/lib.tool.response is required for tool_result.`);
    } else {
      step.tool_output = attrs["lib.tool.response"];
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: step };
}

function readCount(
  attrs: Record<string, unknown>,
  key: string,
  path: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (!Object.hasOwn(attrs, key)) return { ok: true, value: 0 };
  const value = attrs[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: `${path}/lib_attrs/${key} must be an integer greater than or equal to 0.` };
  }
  return { ok: true, value };
}

function readCost(attrs: Record<string, unknown>, path: string): { ok: true; value: number } | { ok: false; error: string } {
  if (!Object.hasOwn(attrs, "lib.usage.cost_usd")) return { ok: true, value: 0 };
  const value = attrs["lib.usage.cost_usd"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `${path}/lib_attrs/lib.usage.cost_usd must be a number greater than or equal to 0.` };
  }
  return { ok: true, value };
}

function totalsOf(steps: readonly TraceStep[]): Trace["totals"] {
  const latency = steps.reduce((sum, step) => sum + step.latency_ms, 0);
  const tokensIn = steps.reduce((sum, step) => sum + step.token_usage.input, 0);
  const tokensOut = steps.reduce((sum, step) => sum + step.token_usage.output, 0);
  const costMicro = steps.reduce((sum, step) => sum + Math.round(step.cost_usd * 1_000_000), 0);
  return { latency_ms: latency, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costMicro / 1_000_000 };
}

function runStatus(trace: Trace): RunStatus {
  if (trace.status === "error") return "error";
  if (trace.status === "completed" && trace.outcome.verifier.passed) return "passed";
  return "failed";
}

function isStepType(value: unknown): value is StepType {
  return typeof value === "string" && (STEP_TYPES as readonly string[]).includes(value);
}

function isStepRole(value: unknown): value is StepRole {
  return typeof value === "string" && (STEP_ROLES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
