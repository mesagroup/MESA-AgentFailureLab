import {
  STEP_ROLES,
  STEP_TYPES,
  TRACE_STATUSES,
  type Run,
  type RunStatus,
  type StepRole,
  type StepType,
  type Trace,
  type TraceOutcome,
  type TraceStatus,
  type TraceStep,
} from "./types.js";
import { validateOtelImport, validateRun, validateTrace } from "./validate.js";

export interface OtelImportContext {
  /** Lab agent that owns the imported traces. Written onto each Trace and Run. */
  agentId: string;
  /**
   * `Agent.otel.service_name` when the source sets one.
   * Each item must then carry the same `service_name`.
   */
  serviceName?: string;
}

export type OtelImportResult =
  | { ok: true; traces: Trace[]; runs: Run[] }
  | { ok: false; errors: string[] };

const FORBIDDEN_ATTRIBUTE = /^(mesa\.fault|mesa\.outcome|fault\.labels|outcome\.verifier)(\.|$)/;

/**
 * Map one OTel import batch onto lab Traces and baseline Runs.
 * Copies `outcome` from the batch. Sets `fault` to the production mark and
 * `diagnosis` to null. Does not read span status into the verifier.
 * Does not call a collector.
 */
export function mapOtelImport(data: unknown, ctx: OtelImportContext): OtelImportResult {
  if (ctx.agentId.trim() === "") {
    return { ok: false, errors: ["agentId must be a non-empty string."] };
  }
  const structural = validateOtelImport(data);
  if (!structural.ok) return structural;
  const batch = structural.value as OtelBatch;
  const errors: string[] = [];
  const traces: Trace[] = [];
  const runs: Run[] = [];
  const seenTraces = new Set<string>();
  const seenRuns = new Set<string>();

  batch.items.forEach((item, itemIndex) => {
    const prefix = `/items/${itemIndex}`;
    if (ctx.serviceName !== undefined && item.service_name !== ctx.serviceName) {
      errors.push(
        item.service_name === undefined
          ? `${prefix}/service_name is required when the agent otel source sets service_name ${ctx.serviceName}.`
          : `${prefix}/service_name must equal the agent otel source service_name ${ctx.serviceName}.`,
      );
    }
    if (seenRuns.has(item.run_id)) errors.push(`${prefix}/run_id duplicate run_id ${item.run_id}`);
    seenRuns.add(item.run_id);

    const outcome = readOutcome(item.outcome, `${prefix}/outcome`);
    if (!outcome.ok) {
      errors.push(outcome.error);
      return;
    }
    const statusError = statusMatchesVerifier(item.status, outcome.value.verifier.passed, `${prefix}/status`);
    if (statusError) errors.push(statusError);

    const mappedSteps = mapSpans(item.spans, prefix);
    if (!mappedSteps.ok) {
      errors.push(...mappedSteps.errors);
      return;
    }
    const traceId = item.trace_id ?? mappedSteps.traceId;
    if (seenTraces.has(traceId)) errors.push(`${prefix} duplicate trace_id ${traceId}`);
    seenTraces.add(traceId);

    const status: TraceStatus =
      item.status ?? (outcome.value.verifier.passed ? "completed" : "failed");
    const trace: Trace = {
      trace_id: traceId,
      agent_id: ctx.agentId,
      run_id: item.run_id,
      task_id: item.task_id,
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
    if (!validated.ok) {
      errors.push(...prefixTraceErrors(itemIndex, validated.errors));
      return;
    }
    const run: Run = {
      run_id: item.run_id,
      agent_id: ctx.agentId,
      task_id: item.task_id,
      phase: "baseline",
      status: runStatus(validated.value),
      trace_ids: [validated.value.trace_id],
      injection_plan: null,
      fix_kinds: [],
      duration_ms: validated.value.totals.latency_ms,
    };
    const validatedRun = validateRun(run);
    if (!validatedRun.ok) {
      errors.push(...prefixTraceErrors(itemIndex, validatedRun.errors));
      return;
    }
    traces.push(validated.value);
    runs.push(validatedRun.value);
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, traces, runs };
}

interface OtelBatch {
  version: 1;
  items: OtelItem[];
}

interface OtelItem {
  task_id: string;
  run_id: string;
  trace_id?: string;
  service_name?: string;
  status?: TraceStatus;
  spans: OtelSpan[];
  outcome: unknown;
}

interface OtelSpan {
  traceId: string;
  spanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status?: { code: "UNSET" | "OK" | "ERROR" };
  attributes: Record<string, unknown>;
}

function readOutcome(value: unknown, path: string): { ok: true; value: TraceOutcome } | { ok: false; error: string } {
  if (!isRecord(value) || !isRecord(value.verifier) || typeof value.success !== "boolean" || typeof value.verifier.passed !== "boolean") {
    return {
      ok: false,
      error: `${path} must include success and verifier.passed. The importer does not invent outcome.verifier.`,
    };
  }
  if (value.success !== value.verifier.passed) {
    return {
      ok: false,
      error: `${path}/success must equal verifier.passed. The importer does not rewrite either field.`,
    };
  }
  return { ok: true, value: value as unknown as TraceOutcome };
}

function statusMatchesVerifier(status: TraceStatus | undefined, passed: boolean, path: string): string | undefined {
  if (status === undefined) return undefined;
  if (!(TRACE_STATUSES as readonly string[]).includes(status)) {
    return `${path} must be completed, failed, timeout, or error.`;
  }
  if (status === "completed" && !passed) {
    return `${path} completed requires the supplied verifier.passed to be true. Span status is not a verdict.`;
  }
  if (status === "failed" && passed) {
    return `${path} failed requires the supplied verifier.passed to be false. Span status is not a verdict.`;
  }
  return undefined;
}

function mapSpans(
  spans: OtelSpan[],
  prefix: string,
): { ok: true; steps: TraceStep[]; traceId: string; startedAt: string; endedAt: string } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const traceIds = new Set(spans.map((span) => span.traceId));
  if (traceIds.size !== 1) {
    errors.push(`${prefix}/spans must share one traceId.`);
  }
  const ordered = spans
    .map((span, index) => ({ span, index }))
    .sort((left, right) => {
      const start = compareNano(left.span.startTimeUnixNano, right.span.startTimeUnixNano);
      if (start !== 0) return start;
      return left.span.spanId.localeCompare(right.span.spanId);
    });
  const seenSpanIds = new Set<string>();
  const steps: TraceStep[] = [];
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = 0;

  ordered.forEach(({ span, index: sourceIndex }, order) => {
    const path = `${prefix}/spans/${sourceIndex}`;
    if (seenSpanIds.has(span.spanId)) errors.push(`${path}/spanId duplicate spanId ${span.spanId}`);
    seenSpanIds.add(span.spanId);
    for (const key of Object.keys(span.attributes)) {
      if (FORBIDDEN_ATTRIBUTE.test(key)) {
        errors.push(`${path}/attributes/${key} is not accepted. The importer does not read fault labels or a verifier from spans.`);
      }
    }
    const start = readNano(span.startTimeUnixNano, `${path}/startTimeUnixNano`);
    const end = readNano(span.endTimeUnixNano, `${path}/endTimeUnixNano`);
    if (!start.ok) errors.push(start.error);
    if (!end.ok) errors.push(end.error);
    if (start.ok && end.ok && end.ms < start.ms) {
      errors.push(`${path}/endTimeUnixNano must be greater than or equal to startTimeUnixNano.`);
    }
    const step = readStep(span, order, path, start.ok ? start.iso : "", start.ok && end.ok ? Math.max(0, end.ms - start.ms) : 0);
    if (!step.ok) {
      errors.push(...step.errors);
      return;
    }
    if (start.ok && end.ok) {
      minStart = Math.min(minStart, start.ms);
      maxEnd = Math.max(maxEnd, end.ms);
    }
    steps.push(step.value);
  });

  if (errors.length > 0 || steps.length !== spans.length) return { ok: false, errors };
  return {
    ok: true,
    steps,
    traceId: spans[0]!.traceId,
    startedAt: new Date(minStart).toISOString(),
    endedAt: new Date(maxEnd).toISOString(),
  };
}

function readStep(
  span: OtelSpan,
  index: number,
  path: string,
  timestamp: string,
  latencyMs: number,
): { ok: true; value: TraceStep } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const attrs = span.attributes;
  const type = attrs["mesa.step.type"];
  const role = attrs["mesa.step.role"];
  if (!isStepType(type)) {
    errors.push(`${path}/attributes/mesa.step.type must be message, tool_call, tool_result, or system.`);
  }
  if (!isStepRole(role)) {
    errors.push(`${path}/attributes/mesa.step.role must be user, assistant, tool, or system.`);
  }
  if (errors.length > 0 || !isStepType(type) || !isStepRole(role)) return { ok: false, errors };

  const tokensIn = readCount(attrs, "mesa.step.tokens_in", "gen_ai.usage.input_tokens", path);
  const tokensOut = readCount(attrs, "mesa.step.tokens_out", "gen_ai.usage.output_tokens", path);
  const cost = readCost(attrs, path);
  if (!tokensIn.ok) errors.push(tokensIn.error);
  if (!tokensOut.ok) errors.push(tokensOut.error);
  if (!cost.ok) errors.push(cost.error);

  const step: TraceStep = {
    step_id: span.spanId,
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
    const content = attrs["mesa.step.content"];
    if (typeof content !== "string") {
      errors.push(`${path}/attributes/mesa.step.content must be a string for ${type}.`);
    } else {
      step.content = content;
    }
  }
  if (type === "tool_call" || type === "tool_result") {
    const toolName = attrs["mesa.tool.name"];
    if (typeof toolName === "string" && toolName.trim() !== "") step.tool_name = toolName;
    else step.tool_name = span.name;
    if (type === "tool_call") {
      const input = readToolInput(attrs, path);
      if (!input.ok) errors.push(input.error);
      else step.tool_input = input.value;
    } else if (!Object.hasOwn(attrs, "mesa.tool.output")) {
      errors.push(`${path}/attributes/mesa.tool.output is required for tool_result.`);
    } else {
      step.tool_output = attrs["mesa.tool.output"];
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: step };
}

function readToolInput(attrs: Record<string, unknown>, path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (Object.hasOwn(attrs, "mesa.tool.input")) return { ok: true, value: attrs["mesa.tool.input"] };
  const raw = attrs["gen_ai.tool.call.arguments"];
  if (typeof raw !== "string") {
    return { ok: false, error: `${path}/attributes/mesa.tool.input is required for tool_call.` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, error: `${path}/attributes/gen_ai.tool.call.arguments must be a JSON string when mesa.tool.input is absent.` };
  }
}

function readCount(
  attrs: Record<string, unknown>,
  primary: string,
  fallback: string,
  path: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (Object.hasOwn(attrs, primary)) return readNonNegativeInteger(attrs[primary], `${path}/attributes/${primary}`);
  if (Object.hasOwn(attrs, fallback)) return readNonNegativeInteger(attrs[fallback], `${path}/attributes/${fallback}`);
  return { ok: true, value: 0 };
}

function readCost(attrs: Record<string, unknown>, path: string): { ok: true; value: number } | { ok: false; error: string } {
  if (!Object.hasOwn(attrs, "mesa.step.cost_usd")) return { ok: true, value: 0 };
  const value = attrs["mesa.step.cost_usd"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `${path}/attributes/mesa.step.cost_usd must be a number greater than or equal to 0.` };
  }
  return { ok: true, value: value };
}

function readNonNegativeInteger(value: unknown, path: string): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: `${path} must be an integer greater than or equal to 0.` };
  }
  return { ok: true, value };
}

function readNano(raw: string, path: string): { ok: true; iso: string; ms: number } | { ok: false; error: string } {
  let nano: bigint;
  try {
    nano = BigInt(raw);
  } catch {
    return { ok: false, error: `${path} must be a decimal unix nanosecond string.` };
  }
  const ms = nano / 1_000_000n;
  if (ms < 0n || ms > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: `${path} is outside the range of a millisecond timestamp.` };
  }
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return { ok: false, error: `${path} is not a valid time.` };
  return { ok: true, iso: date.toISOString(), ms: Number(ms) };
}

function compareNano(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
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

function prefixTraceErrors(itemIndex: number, errors: string[]): string[] {
  return errors.map((error) => {
    const space = error.indexOf(" ");
    const where = space === -1 ? error : error.slice(0, space);
    const rest = space === -1 ? "" : error.slice(space);
    if (where.startsWith("/")) return `/items/${itemIndex}${where}${rest}`;
    return `/items/${itemIndex} ${error}`;
  });
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
