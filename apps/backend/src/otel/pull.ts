import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIBRARY_OTEL_SCHEMA_B_ID,
  SHOP_OTEL_SCHEMA_A_ID,
  type Agent,
  type OtelMockChannel,
  type OtelSourceEndpoint,
  type Run,
  type Trace,
  type TraceSource,
} from "@mesa/shared";
import { remapLibrarySchemaB, remapShopSchemaA, type OtelImportResult } from "@mesa/shared/otel";
import { validateTrace } from "@mesa/shared/validate";
import type { RunStore } from "../persistence/store.js";
import { isRecord } from "../util.js";

/** How long one endpoint GET may take before the pull reports a network error. */
export const OTEL_PULL_TIMEOUT_MS = 10_000;

export type OtelPullErrorKind = "network" | "auth" | "remap" | "validation" | "conflict";

export interface OtelPullError {
  source: OtelMockChannel;
  kind: OtelPullErrorKind;
  message: string;
}

export interface OtelPullSourceResult {
  source: OtelMockChannel;
  tag: TraceSource;
  /** `none` when the source failed before a body was read. */
  transport: "http" | "fixture" | "none";
  /**
   * Inclusive lower bound sent to the endpoint.
   * Null on the first successful-cursor-less pull: `since` is omitted and the endpoint returns its buffer.
   */
  since: string | null;
  /** Server time at the start of this pull. The cursor advances to this instant on success. */
  until: string;
  previous_last_pull_at: string | null;
  /** Cursor stored after this source. Null when this source did not succeed. */
  last_pull_at: string | null;
  imported: number;
  skipped: number;
  failed: number;
  /** True when the fetch succeeded and the body had no spans left. */
  empty: boolean;
  message: string;
  trace_ids: string[];
  errors: OtelPullError[];
}

export interface OtelPullResponse {
  agent_id: string;
  imported: number;
  skipped: number;
  failed: number;
  sources: OtelPullSourceResult[];
  errors: OtelPullError[];
}

export interface OtelPullCursors {
  agent_id: string;
  prod: { tag: "otel_prod"; last_pull_at: string | null };
  test: { tag: "otel_test"; last_pull_at: string | null };
}

export type OtelFetch = typeof fetch;

export interface PullAgentTracesOptions {
  agent: Agent;
  store: RunStore;
  body: unknown;
  now?: Date;
  fetchImpl?: OtelFetch;
}

export type PullAgentTracesResult =
  | { status: 200; body: OtelPullResponse }
  | { status: 400; body: { error: string; message: string } };

/**
 * Fetch each requested OTel source, remap with the agent's schema, validate, and upsert.
 * Does not invent `outcome.verifier` or `fault.labels`. Does not call Grok.
 * Does not take the mock-world gate.
 */
export async function pullAgentTraces(options: PullAgentTracesOptions): Promise<PullAgentTracesResult> {
  const parsed = parsePullBody(options.body);
  if (!parsed.ok) return { status: 400, body: { error: "invalid_request", message: parsed.message } };
  if (!options.agent.otel) {
    return {
      status: 400,
      body: {
        error: "otel_not_configured",
        message: `Agent ${options.agent.agent_id} has no otel source. Register otel.prod and otel.test before pulling traces.`,
      },
    };
  }
  const now = options.now ?? new Date();
  if (parsed.since && Date.parse(parsed.since) > now.getTime()) {
    return {
      status: 400,
      body: { error: "invalid_request", message: "since must be at or before the server time of this pull." },
    };
  }
  const until = now.toISOString();
  const sources: OtelPullSourceResult[] = [];
  for (const source of parsed.sources) {
    sources.push(
      await pullOneSource({
        agent: options.agent,
        store: options.store,
        source,
        explicitSince: parsed.since,
        until,
        fetchImpl: options.fetchImpl ?? fetch,
      }),
    );
  }
  return {
    status: 200,
    body: {
      agent_id: options.agent.agent_id,
      imported: sources.reduce((sum, source) => sum + source.imported, 0),
      skipped: sources.reduce((sum, source) => sum + source.skipped, 0),
      failed: sources.reduce((sum, source) => sum + source.failed, 0),
      sources,
      errors: sources.flatMap((source) => source.errors),
    },
  };
}

export async function readOtelPullCursors(store: RunStore, agentId: string): Promise<OtelPullCursors> {
  const prod = await store.getOtelPullCursor(agentId, "prod");
  const test = await store.getOtelPullCursor(agentId, "test");
  return {
    agent_id: agentId,
    prod: { tag: "otel_prod", last_pull_at: prod ?? null },
    test: { tag: "otel_test", last_pull_at: test ?? null },
  };
}

function parsePullBody(
  body: unknown,
): { ok: true; sources: OtelMockChannel[]; since: string | null } | { ok: false; message: string } {
  if (body === undefined || body === null) return { ok: true, sources: ["prod", "test"], since: null };
  if (!isRecord(body)) return { ok: false, message: "Body must be a JSON object." };
  const unknown = Object.keys(body).filter((key) => key !== "sources" && key !== "since");
  if (unknown.length > 0) {
    return { ok: false, message: `Unknown field ${unknown[0]}. Send sources and since only.` };
  }
  let sources: OtelMockChannel[];
  if (body.sources === undefined) sources = ["prod", "test"];
  else if (!Array.isArray(body.sources) || body.sources.length === 0) {
    return { ok: false, message: "sources must be a non-empty array of prod and/or test." };
  } else {
    const next: OtelMockChannel[] = [];
    for (const entry of body.sources) {
      if (entry !== "prod" && entry !== "test") {
        return { ok: false, message: "sources must list prod and/or test." };
      }
      if (next.includes(entry)) return { ok: false, message: "sources must not repeat a value." };
      next.push(entry);
    }
    sources = next;
  }
  if (body.since === undefined || body.since === null) return { ok: true, sources, since: null };
  if (typeof body.since !== "string" || !body.since.includes("T")) {
    return { ok: false, message: "since must be an ISO-8601 date-time." };
  }
  const parsed = new Date(body.since);
  if (Number.isNaN(parsed.getTime())) return { ok: false, message: "since must be an ISO-8601 date-time." };
  return { ok: true, sources, since: parsed.toISOString() };
}

async function pullOneSource(input: {
  agent: Agent;
  store: RunStore;
  source: OtelMockChannel;
  explicitSince: string | null;
  until: string;
  fetchImpl: OtelFetch;
}): Promise<OtelPullSourceResult> {
  const tag: TraceSource = input.source === "prod" ? "otel_prod" : "otel_test";
  const previous = (await input.store.getOtelPullCursor(input.agent.agent_id, input.source)) ?? null;
  const since = input.explicitSince ?? previous;
  const base = {
    source: input.source,
    tag,
    since,
    until: input.until,
    previous_last_pull_at: previous,
    imported: 0,
    skipped: 0,
    failed: 0,
    empty: false,
    trace_ids: [] as string[],
    errors: [] as OtelPullError[],
  };
  const endpoint = input.agent.otel?.[input.source];
  if (!endpoint) {
    return fail(base, "validation", `Agent ${input.agent.agent_id} has no otel.${input.source} endpoint.`);
  }
  const schemaId = input.agent.otel?.schema_id;
  if (schemaId !== SHOP_OTEL_SCHEMA_A_ID && schemaId !== LIBRARY_OTEL_SCHEMA_B_ID) {
    return fail(
      base,
      "remap",
      `otel.schema_id ${schemaId ?? "(missing)"} is not ${SHOP_OTEL_SCHEMA_A_ID} or ${LIBRARY_OTEL_SCHEMA_B_ID}.`,
    );
  }

  let transport: OtelPullSourceResult["transport"] = "http";
  let fallbackNote: string | null = null;
  let payload: unknown;
  try {
    payload = await fetchExport(endpoint, since, input.fetchImpl);
  } catch (error) {
    const pullError = asPullError(error);
    if (!pullError.allowFixture || !canUseFixture(input.agent, schemaId)) {
      return fail(base, pullError.kind, pullError.message);
    }
    try {
      payload = applySince(readAgentFixture(input.agent, input.source), since);
      transport = "fixture";
      fallbackNote = `HTTP pull failed (${pullError.message}). Loaded the otel_mock fixture for ${input.source}.`;
    } catch (fixtureError) {
      const detail = fixtureError instanceof Error ? fixtureError.message : "Fixture fallback failed.";
      return fail(base, "network", `${pullError.message} Fixture fallback failed: ${detail}`);
    }
  }

  const channel = exportChannel(payload);
  if (channel !== undefined && channel !== input.source) {
    return {
      ...fail(
        base,
        "validation",
        `The ${input.source} endpoint returned channel ${channel}. Point otel.${input.source}.endpoint at that source.`,
      ),
      transport,
    };
  }
  const spans = spanCount(payload);
  if (spans === 0) {
    await input.store.setOtelPullCursor(input.agent.agent_id, input.source, input.until);
    const message = joinMessage(
      fallbackNote,
      since
        ? `No spans at or after ${since}.`
        : "The endpoint returned no spans.",
    );
    return {
      ...base,
      transport,
      last_pull_at: input.until,
      empty: true,
      message,
    };
  }

  const mapped = remapExport(schemaId, payload, input.agent.agent_id);
  if (!mapped.ok) {
    return {
      ...fail(base, "remap", mapped.errors.join("; ")),
      transport,
      message: joinMessage(fallbackNote, mapped.errors.join("; ")),
    };
  }
  if (mapped.traces.length !== mapped.runs.length) {
    return {
      ...fail(base, "remap", `Remap returned ${mapped.traces.length} traces and ${mapped.runs.length} runs.`),
      transport,
    };
  }

  const saved = await upsertMapped(input.store, input.agent.agent_id, tag, mapped.traces, mapped.runs);
  const succeeded = saved.failed === 0;
  if (succeeded) await input.store.setOtelPullCursor(input.agent.agent_id, input.source, input.until);
  const message = joinMessage(
    fallbackNote,
    saved.failed > 0
      ? saved.errors[0]?.message ?? "Pull failed."
      : saved.imported > 0
        ? `Imported ${saved.imported} trace${saved.imported === 1 ? "" : "s"}.`
        : saved.skipped > 0
          ? "Already stored. Re-pull did not add a row."
          : "Pull finished with nothing to store.",
  );
  return {
    ...base,
    transport,
    last_pull_at: succeeded ? input.until : null,
    imported: saved.imported,
    skipped: saved.skipped,
    failed: saved.failed,
    empty: false,
    message,
    trace_ids: saved.traceIds,
    errors: saved.errors.map((error) => ({ ...error, source: input.source })),
  };
}

function fail(
  base: Omit<OtelPullSourceResult, "transport" | "last_pull_at" | "message">,
  kind: OtelPullErrorKind,
  message: string,
): OtelPullSourceResult {
  return {
    ...base,
    transport: "none",
    last_pull_at: null,
    failed: 1,
    message,
    errors: [{ source: base.source, kind, message }],
  };
}

function joinMessage(prefix: string | null, text: string): string {
  return prefix ? `${prefix} ${text}` : text;
}

async function fetchExport(endpoint: OtelSourceEndpoint, since: string | null, fetchImpl: OtelFetch): Promise<unknown> {
  const url = tracesUrl(endpoint.endpoint, since);
  const headers: Record<string, string> = { accept: "application/json" };
  if (endpoint.auth.type === "bearer") {
    const name = endpoint.auth.token_env;
    if (!name) {
      throw new PullRequestError("auth", "otel auth.type bearer requires auth.token_env. The pull route does not store the token.");
    }
    const token = process.env[name];
    if (typeof token !== "string" || token.trim() === "") {
      throw new PullRequestError(
        "auth",
        `Set ${name} on the lab process. The pull route reads that env var and does not store the token.`,
      );
    }
    headers.authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(OTEL_PULL_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof PullRequestError) throw error;
    const message = error instanceof Error ? error.message : "request failed";
    throw new PullRequestError("network", `GET ${url.toString()} failed: ${message}`, true);
  }
  if (response.status === 401 || response.status === 403) {
    const name = endpoint.auth.token_env ?? "the bearer token";
    throw new PullRequestError(
      "auth",
      `GET ${url.toString()} returned ${response.status}. Check ${name} on the lab process.`,
    );
  }
  if (!response.ok) {
    const detail = await responseSnippet(response);
    throw new PullRequestError("network", `GET ${url.toString()} returned ${response.status}. ${detail}`.trim());
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new PullRequestError("validation", `GET ${url.toString()} did not return JSON.`);
  }
}

class PullRequestError extends Error {
  readonly allowFixture: boolean;

  constructor(
    readonly kind: "network" | "auth" | "validation",
    message: string,
    allowFixture = false,
  ) {
    super(message);
    this.name = "PullRequestError";
    this.allowFixture = allowFixture;
  }
}

function asPullError(error: unknown): { kind: "network" | "auth" | "validation"; message: string; allowFixture: boolean } {
  if (error instanceof PullRequestError) {
    return { kind: error.kind, message: error.message, allowFixture: error.allowFixture };
  }
  const message = error instanceof Error ? error.message : "Pull failed.";
  return { kind: "network", message, allowFixture: false };
}

function tracesUrl(endpoint: string, since: string | null): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PullRequestError("network", `otel endpoint is not a URL: ${endpoint}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PullRequestError("network", `otel endpoint must be http or https: ${endpoint}`);
  }
  if (since) url.searchParams.set("since", since);
  return url;
}

async function responseSnippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (text === "") return "";
    return text.slice(0, 180);
  } catch {
    return "";
  }
}

function canUseFixture(agent: Agent, schemaId: string): boolean {
  return agent.otel_mock?.mode === "fixture" && agent.otel_mock.schema_id === schemaId;
}

function readAgentFixture(agent: Agent, channel: OtelMockChannel): unknown {
  const fixturePath = agent.otel_mock?.sources[channel]?.fixture_path;
  if (typeof fixturePath !== "string" || fixturePath.trim() === "") {
    throw new Error(`otel_mock.sources.${channel}.fixture_path is missing.`);
  }
  return JSON.parse(readFileSync(resolveFixturePath(fixturePath.trim()), "utf8")) as unknown;
}

function resolveFixturePath(fixturePath: string): string {
  if (isAbsolute(fixturePath)) return fixturePath;
  const prefix = "packages/shared/";
  if (fixturePath.startsWith(prefix)) {
    const examplesDir = dirname(fileURLToPath(import.meta.resolve("@mesa/shared/examples/agent-reference-shop.json")));
    const sharedRoot = dirname(examplesDir);
    return join(sharedRoot, fixturePath.slice(prefix.length));
  }
  throw new Error(`fixture_path must be absolute or start with packages/shared/: ${fixturePath}`);
}

function applySince(data: unknown, since: string | null): unknown {
  if (!since || !isRecord(data) || !Array.isArray(data.spans)) return data;
  const sinceMs = Date.parse(since);
  const spans = data.spans.filter((span) => {
    if (!isRecord(span)) return false;
    if (typeof span.opened_ms === "number") return span.opened_ms >= sinceMs;
    if (typeof span.started_at === "string") return Date.parse(span.started_at) >= sinceMs;
    return false;
  });
  return { ...data, spans };
}

function exportChannel(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  if (isRecord(data.shop_export) && typeof data.shop_export.channel === "string") return data.shop_export.channel;
  if (isRecord(data.library_export) && typeof data.library_export.channel === "string") return data.library_export.channel;
  return undefined;
}

function spanCount(data: unknown): number | null {
  if (!isRecord(data) || !Array.isArray(data.spans)) return null;
  return data.spans.length;
}

function remapExport(schemaId: string, payload: unknown, agentId: string): OtelImportResult {
  if (schemaId === SHOP_OTEL_SCHEMA_A_ID) return remapShopSchemaA(payload, { agentId });
  return remapLibrarySchemaB(payload, { agentId });
}

async function upsertMapped(
  store: RunStore,
  agentId: string,
  tag: TraceSource,
  traces: readonly Trace[],
  runs: readonly Run[],
): Promise<{ imported: number; skipped: number; failed: number; traceIds: string[]; errors: Array<Omit<OtelPullError, "source">> }> {
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const traceIds: string[] = [];
  const errors: Array<Omit<OtelPullError, "source">> = [];
  for (let index = 0; index < traces.length; index += 1) {
    const trace = traces[index]!;
    const run = runs[index]!;
    const tagged = validateTrace({ ...trace, source: tag });
    if (!tagged.ok) {
      failed += 1;
      errors.push({ kind: "validation", message: `Trace ${trace.trace_id} failed validateTrace: ${tagged.errors.join("; ")}` });
      continue;
    }
    const existingTrace = await store.getTrace(tagged.value.trace_id);
    if (existingTrace && existingTrace.agent_id !== agentId) {
      failed += 1;
      errors.push({
        kind: "conflict",
        message: `Trace ${tagged.value.trace_id} is stored for agent ${existingTrace.agent_id}. Pull does not move it.`,
      });
      continue;
    }
    if (
      existingTrace &&
      (existingTrace.fault.injected || existingTrace.fault.labels.length > 0 || existingTrace.fault.attacker.used)
    ) {
      failed += 1;
      errors.push({
        kind: "conflict",
        message: `Trace ${tagged.value.trace_id} already has injector or attacker fault labels. Pull does not overwrite fault ground truth.`,
      });
      continue;
    }
    const existingRun = await store.getRun(run.run_id);
    if (existingRun && existingRun.agent_id !== agentId) {
      failed += 1;
      errors.push({
        kind: "conflict",
        message: `Run ${run.run_id} is stored for agent ${existingRun.agent_id}. Pull does not move it.`,
      });
      continue;
    }
    if (
      existingRun &&
      (existingRun.phase !== "baseline" || existingRun.injection_plan !== null || existingRun.fix_kinds.length > 0)
    ) {
      failed += 1;
      errors.push({
        kind: "conflict",
        message: `Run ${run.run_id} is a harness run. Pull does not overwrite it.`,
      });
      continue;
    }
    let next = tagged.value;
    if (existingTrace?.diagnosis && next.diagnosis === null) {
      const kept = validateTrace({ ...next, diagnosis: existingTrace.diagnosis });
      if (kept.ok) next = kept.value;
    }
    const traceSame = existingTrace !== undefined && isDeepStrictEqual(existingTrace, next);
    const runSame = existingRun !== undefined && isDeepStrictEqual(existingRun, run);
    if (traceSame && runSame) {
      skipped += 1;
      traceIds.push(next.trace_id);
      continue;
    }
    await store.saveRun(run);
    await store.saveTrace(next);
    imported += 1;
    traceIds.push(next.trace_id);
  }
  return { imported, skipped, failed, traceIds, errors };
}
