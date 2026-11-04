import type { FaultCategory, FixKind } from "@mesa/shared";
import { ADR_FIX_BY_CATEGORY, normalizeFixes } from "../fixes/domain.js";
import type { FixSource } from "./types.js";

/**
 * Specified fixes win. A non-empty diagnosis proposal is next.
 * Otherwise the ADR-002 category map. An empty diagnosis falls through.
 * This function does not call Grok.
 */
export function selectFixes(input: {
  specified?: readonly FixKind[];
  diagnosisFixes?: readonly FixKind[];
  category: FaultCategory;
}): { kinds: readonly FixKind[]; source: FixSource } {
  if (input.specified !== undefined) {
    return { kinds: normalizeFixes(input.specified), source: "specified" };
  }
  if (input.diagnosisFixes !== undefined && input.diagnosisFixes.length > 0) {
    return { kinds: normalizeFixes(input.diagnosisFixes), source: "diagnosis" };
  }
  const mapped = ADR_FIX_BY_CATEGORY[input.category];
  if (mapped === undefined) return { kinds: [], source: "none" };
  return { kinds: [mapped], source: "adr-002-category-map" };
}
