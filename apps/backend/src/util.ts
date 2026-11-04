export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readParamString(
  params: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!params) return undefined;
  return stringField(params, key);
}

export function readParamNumber(
  params: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  if (!params) return undefined;
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/** Compare money amounts that may have arrived as JSON numbers. */
export function usdEqual(left: number, right: number): boolean {
  return Math.round(left * 100) === Math.round(right * 100);
}

export function lineTotalUsd(items: readonly { qty: number; unit_price_usd: number }[]): number {
  const cents = items.reduce((sum, line) => sum + Math.round(line.unit_price_usd * 100) * line.qty, 0);
  return cents / 100;
}

export function formatUsd(value: number): string {
  const cents = Math.round(value * 100);
  if (cents % 100 === 0) return String(cents / 100);
  return (cents / 100).toFixed(2).replace(/0$/, "");
}
