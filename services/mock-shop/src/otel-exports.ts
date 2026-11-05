import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export const MOCK_OTEL_TRACES_PATH = "/internal/otel/traces";
export const MOCK_OTEL_SCHEMA_HEADER = "X-Mock-Otel-Schema";
export const MOCK_OTEL_SCHEMA_VALUE = "mesa.otel.shop.a";

const FILES = {
  prod: "prod-t1-search.json",
  test: "test-t2-cart.json",
} as const;

export type ShopOtelSource = keyof typeof FILES;

interface ShopSpan {
  opened_ms: number;
}

function fixtureDir(): string {
  const fromEnv = process.env.OTEL_SHOP_A_DIR?.trim();
  const candidates = [
    fromEnv,
    join(moduleDir, "..", "otel-shop-schema-a"),
    join(moduleDir, "..", "..", "..", "packages", "shared", "examples", "otel", "shop-schema-a"),
  ];
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, FILES.prod))) return dir;
  }
  throw new Error(
    "Shop schema A fixtures were not found. Set OTEL_SHOP_A_DIR to packages/shared/examples/otel/shop-schema-a.",
  );
}

export function isShopOtelSource(value: string): value is ShopOtelSource {
  return value === "prod" || value === "test";
}

export function readShopOtelExport(source: ShopOtelSource): unknown {
  return JSON.parse(readFileSync(join(fixtureDir(), FILES[source]), "utf8")) as unknown;
}

/**
 * Seed export for `source`. When `sinceMs` is set, keep spans with `opened_ms` >= that time.
 * When `sinceMs` is omitted, return the entire seed. Does not touch shop world state.
 */
export function shopOtelTraces(source: ShopOtelSource, sinceMs: number | undefined): unknown {
  const doc = structuredClone(readShopOtelExport(source)) as { spans: ShopSpan[] };
  if (sinceMs !== undefined) {
    doc.spans = doc.spans.filter((span) => span.opened_ms >= sinceMs);
  }
  return doc;
}
