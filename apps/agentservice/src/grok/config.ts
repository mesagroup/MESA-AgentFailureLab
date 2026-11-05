import { GROK_MODEL_ID } from "@mesa/shared";

/**
 * Environment boundary for the diagnosis client.
 * `GROK_MODEL` is read here and nowhere else. Callers receive `modelName`.
 * Unset, diagnosis uses the same Grok 4.6 id as the shop planner.
 */

export interface DiagnosisConfig {
  apiKey: string | null;
  baseUrl: string;
  modelName: string;
  timeoutMs: number;
}

const DEFAULT_MODEL = GROK_MODEL_ID;
const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export function parseDiagnosisConfig(env: NodeJS.ProcessEnv): DiagnosisConfig {
  return {
    apiKey: readApiKey(env.XAI_API_KEY),
    baseUrl: readBaseUrl(env.XAI_BASE_URL),
    modelName: readModel(env.GROK_MODEL),
    timeoutMs: readTimeout(env.GROK_TIMEOUT_MS),
  };
}

function readApiKey(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function readModel(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : DEFAULT_MODEL;
}

function readBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim() || DEFAULT_BASE_URL;
  const withoutSlash = trimmed.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(withoutSlash);
  } catch {
    throw new Error(`Invalid XAI_BASE_URL: ${value ?? ""}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid XAI_BASE_URL: ${value ?? ""}`);
  }
  return withoutSlash;
}

function readTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid GROK_TIMEOUT_MS: ${value}`);
  }
  return parsed;
}
