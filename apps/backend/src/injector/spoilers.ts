import { isRecord } from "../util.js";

/**
 * Boundary between harness ground truth and model-visible step fields.
 *
 * `fault.injected`, `fault.labels`, and `fault.attacker` are the answer key.
 * They are written by the injector or the attacker and are not copied into
 * `content`, `tool_input`, or `tool_output`. Diagnosis reads those step fields
 * and does not read `fault`. See ADR-002.
 *
 * `scrubSpoilers` is the sanitizer for that boundary. A later attacker can run
 * the same function on any payload before it is stored on a step.
 */

const FLAG_KEYS = ["forged", "stale", "injected"] as const;

type FlagKey = (typeof FLAG_KEYS)[number];

/** Stable ids asserted by tests. Boolean flags and the historical sentences. */
export const SPOILER_MARKER_IDS = [
  "Injected",
  "Injector skipped",
  "Injector target",
  "forged:true",
  "forged:false",
  "stale:true",
  "stale:false",
  "injected:true",
  "injected:false",
] as const;

export type SpoilerMarkerId = (typeof SPOILER_MARKER_IDS)[number];

/** Tool-result text for a dropped call. Names the timeout, not the injector. */
export const NEUTRAL_TIMEOUT_MESSAGE = "The tool did not respond before the time limit.";

const HISTORICAL_DROP = "Injected execution drop before the mock was called.";

function isFlagKey(key: string): key is FlagKey {
  return (FLAG_KEYS as readonly string[]).includes(key);
}

function flagMarker(key: FlagKey, value: unknown): SpoilerMarkerId | undefined {
  if (value === true || value === "true") return `${key}:true`;
  if (value === false || value === "false") return `${key}:false`;
  return undefined;
}

/** Markers in a value that would be visible if it were stored on a trace step. */
export function spoilerMarkersIn(value: unknown): SpoilerMarkerId[] {
  const found = new Set<SpoilerMarkerId>();
  walk(value, found);
  return SPOILER_MARKER_IDS.filter((id) => found.has(id));
}

function walk(value: unknown, found: Set<SpoilerMarkerId>): void {
  if (typeof value === "string") {
    for (const id of textMarkers(value)) found.add(id);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, found);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isFlagKey(key)) {
      const marker = flagMarker(key, child);
      if (marker) found.add(marker);
    }
    walk(child, found);
  }
}

function textMarkers(text: string): SpoilerMarkerId[] {
  const found: SpoilerMarkerId[] = [];
  if (text.includes(HISTORICAL_DROP) || /\bInjected\b/.test(text)) found.push("Injected");
  if (text.includes("Injector skipped")) found.push("Injector skipped");
  if (text.includes("Injector target") && text.includes("was not called.")) found.push("Injector target");
  if (flagText(text, "forged", "true")) found.push("forged:true");
  if (flagText(text, "forged", "false")) found.push("forged:false");
  if (flagText(text, "stale", "true")) found.push("stale:true");
  if (flagText(text, "stale", "false")) found.push("stale:false");
  if (flagText(text, "injected", "true")) found.push("injected:true");
  if (flagText(text, "injected", "false")) found.push("injected:false");
  return found;
}

function flagText(text: string, key: FlagKey, literal: "true" | "false"): boolean {
  return new RegExp(`"?${key}"?\\s*:\\s*${literal}\\b`, "i").test(text);
}

/** Remove spoiler markers. Shop-shaped fields other than the flag keys are kept. */
export function scrubSpoilers<T>(value: T): T {
  return scrub(value) as T;
}

function scrub(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isFlagKey(key)) continue;
    next[key] = scrub(child);
  }
  return next;
}

function scrubString(value: string): string {
  let next = value.replaceAll(HISTORICAL_DROP, NEUTRAL_TIMEOUT_MESSAGE);
  next = next.replace(/Injector skipped [^.]*(?:\.|$)/g, "");
  next = next.replace(/Injector target [^.]*was not called\./g, "");
  next = next.replace(/\bInjected\b/g, "");
  next = next.replace(/"?(?:forged|stale|injected)"?\s*:\s*(?:true|false)\b/gi, "");
  if (next === value) return value;
  return next.replace(/[ \t]{2,}/g, " ").trim();
}
