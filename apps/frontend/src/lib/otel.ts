import { OTEL_SOURCE_VERSION, type OtelSourceAuthType, type OtelSourceConfig } from "@mesa/shared";

const TOKEN_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Form fields for the optional `Agent.otel` source. `enabled` false omits the field on save. */
export interface OtelSourceDraft {
  enabled: boolean;
  prodEndpoint: string;
  testEndpoint: string;
  authType: OtelSourceAuthType;
  /** Env var name. Never a bearer token. */
  tokenEnv: string;
  serviceName: string;
}

export interface OtelSourceFieldError {
  prod_endpoint?: string;
  test_endpoint?: string;
  token_env?: string;
  service_name?: string;
}

export function emptyOtelDraft(): OtelSourceDraft {
  return {
    enabled: false,
    prodEndpoint: "",
    testEndpoint: "",
    authType: "none",
    tokenEnv: "",
    serviceName: "",
  };
}

export function otelDraftFromAgent(otel: OtelSourceConfig | undefined): OtelSourceDraft {
  if (!otel) return emptyOtelDraft();
  return {
    enabled: true,
    prodEndpoint: otel.prod.endpoint,
    testEndpoint: otel.test.endpoint,
    authType: otel.prod.auth.type,
    tokenEnv: otel.prod.auth.token_env ?? "",
    serviceName: otel.prod.service_name ?? "",
  };
}

export function otelSourceErrors(draft: OtelSourceDraft): OtelSourceFieldError {
  if (!draft.enabled) return {};
  const error: OtelSourceFieldError = {};
  const prodEndpoint = draft.prodEndpoint.trim();
  const testEndpoint = draft.testEndpoint.trim();
  if (!prodEndpoint) error.prod_endpoint = "Enter the prod traces URL.";
  else if (!isHttpUrl(prodEndpoint)) error.prod_endpoint = "Enter an http or https URL.";
  if (!testEndpoint) error.test_endpoint = "Enter the test traces URL.";
  else if (!isHttpUrl(testEndpoint)) error.test_endpoint = "Enter an http or https URL.";
  if (draft.authType === "bearer") {
    const name = draft.tokenEnv.trim();
    if (!name) error.token_env = "Enter the env var name that holds the bearer token. Do not paste the token.";
    else if (!TOKEN_ENV_NAME.test(name)) {
      error.token_env = "Use an env var name like OTEL_SOURCE_TOKEN. Do not paste the token.";
    }
  }
  if (draft.serviceName.length > 0 && draft.serviceName.trim().length === 0) {
    error.service_name = "Enter a service name, or leave it blank.";
  }
  return error;
}

export function otelSourceHasErrors(errors: OtelSourceFieldError): boolean {
  return Boolean(errors.prod_endpoint || errors.test_endpoint || errors.token_env || errors.service_name);
}

/**
 * `version` is always 1. Bearer auth stores the env var name only.
 * `none` omits `token_env`. A blank service name omits `service_name`.
 */
export function otelSourceFromDraft(draft: OtelSourceDraft): OtelSourceConfig | undefined {
  if (!draft.enabled) return undefined;
  const auth =
    draft.authType === "bearer"
      ? { type: "bearer" as const, token_env: draft.tokenEnv.trim() }
      : { type: "none" as const };
  const serviceName = draft.serviceName.trim();
  const prod = { endpoint: draft.prodEndpoint.trim(), auth };
  const test = { endpoint: draft.testEndpoint.trim(), auth };
  const source: OtelSourceConfig = {
    version: OTEL_SOURCE_VERSION,
    prod: serviceName ? { ...prod, service_name: serviceName } : prod,
    test: serviceName ? { ...test, service_name: serviceName } : test,
  };
  return source;
}

export function parseOtelBatch(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Paste a span batch, or choose a JSON file." };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false, error: "That text is not JSON." };
  }
}

/** Primary text plus the HTTP code for a failed `POST /agents/:agentId/otel/import`. */
export function otelImportErrorText(error: unknown): { message: string; details: string | null } {
  const api = readApiError(error);
  if (api?.status === 409) {
    return {
      message: api.message.trim().length > 0 && api.message !== api.code
        ? api.message
        : "That trace id or run id is already stored.",
      details: api.details,
    };
  }
  if (api?.status === 400) {
    return {
      message: api.message.trim().length > 0 && api.message !== api.code
        ? api.message
        : "The span batch could not be mapped to a Trace.",
      details: api.details,
    };
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return { message: error.message, details: api?.details ?? null };
  }
  return { message: "The request failed.", details: api?.details ?? null };
}

function readApiError(error: unknown): { status: number; message: string; code?: string; details: string } | undefined {
  if (typeof error !== "object" || error === null || !("status" in error) || !("message" in error)) return undefined;
  const status = error.status;
  const message = error.message;
  if (typeof status !== "number" || typeof message !== "string") return undefined;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { status, message, code, details: code ? `HTTP ${status} ${code}` : `HTTP ${status}` };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
