import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LIBRARY_OTEL_SCHEMA_HINT = "mesa.otel.library.b";

const ALLOWED_QUERY = new Set(["source", "since"]);

export type OtelChannel = "prod" | "test";

interface LibrarySpan {
  started_at: string;
  ended_at: string;
  [key: string]: unknown;
}

interface LibraryExport {
  schema_hint: string;
  library_export: Record<string, unknown>;
  spans: LibrarySpan[];
}

export function defaultOtelSeedDir(): string {
  const fromEnv = process.env.LIBRARY_OTEL_SEED_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(dirname(fileURLToPath(import.meta.url)), "../../../packages/shared/examples/otel/library-schema-b");
}

export function loadOtelSeeds(seedDir: string): { prod: LibraryExport; test: LibraryExport } {
  return {
    prod: readExport(join(seedDir, "prod-renew-loan.json")),
    test: readExport(join(seedDir, "test-return-loan.json")),
  };
}

export type OtelQueryResult =
  | { ok: true; body: LibraryExport }
  | { ok: false; message: string };

/**
 * Parse GET /internal/otel/traces. Read-only. Does not touch library world state.
 */
export function resolveOtelQuery(
  query: unknown,
  schemaHeader: string | undefined,
  seeds: { prod: LibraryExport; test: LibraryExport },
): OtelQueryResult {
  if (schemaHeader !== undefined && schemaHeader !== LIBRARY_OTEL_SCHEMA_HINT) {
    return { ok: false, message: `X-Mock-Otel-Schema must be ${LIBRARY_OTEL_SCHEMA_HINT} when set.` };
  }
  if (!isRecord(query)) {
    return { ok: false, message: "Query must be a map of string parameters." };
  }
  for (const key of Object.keys(query)) {
    if (!ALLOWED_QUERY.has(key)) {
      return { ok: false, message: `Unknown query parameter ${key}.` };
    }
  }
  const sourceRaw = query.source;
  if (sourceRaw !== undefined && Array.isArray(sourceRaw)) {
    return { ok: false, message: "source must be prod or test." };
  }
  const sourceText = sourceRaw === undefined ? "prod" : String(sourceRaw);
  if (sourceText !== "prod" && sourceText !== "test") {
    return { ok: false, message: "source must be prod or test." };
  }
  const sinceRaw = query.since;
  if (sinceRaw !== undefined && Array.isArray(sinceRaw)) {
    return { ok: false, message: "since must be an ISO-8601 date-time." };
  }
  let sinceMs: number | undefined;
  if (sinceRaw !== undefined) {
    const sinceText = String(sinceRaw).trim();
    sinceMs = Date.parse(sinceText);
    if (sinceText === "" || Number.isNaN(sinceMs)) {
      return { ok: false, message: "since must be an ISO-8601 date-time." };
    }
  }
  const seed = structuredClone(seeds[sourceText]);
  if (sinceMs !== undefined) {
    seed.spans = seed.spans.filter((span) => Date.parse(span.started_at) >= sinceMs);
  }
  return { ok: true, body: seed };
}

function readExport(path: string): LibraryExport {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.spans)) {
    throw new Error(`${path} is not a library schema B export.`);
  }
  return parsed as unknown as LibraryExport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
