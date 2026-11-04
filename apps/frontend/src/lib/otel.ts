import { OTEL_SOURCE_VERSION, type OtelSourceAuthType, type OtelSourceConfig } from "@mesa/shared";

const TOKEN_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Form fields for the optional `Agent.otel` source. `enabled` false omits the field on save. */
export interface OtelSourceDraft {
  enabled: boolean;
  endpoint: string;
  authType: OtelSourceAuthType;
  /** Env var name. Never a bearer token. */
  tokenEnv: string;
  serviceName: string;
}

export interface OtelSourceFieldError {
  endpoint?: string;
  token_env?: string;
  service_name?: string;
}

export function emptyOtelDraft(): OtelSourceDraft {
  return { enabled: false, endpoint: "", authType: "none", tokenEnv: "", serviceName: "" };
}

export function otelDraftFromAgent(otel: OtelSourceConfig | undefined): OtelSourceDraft {
  if (!otel) return emptyOtelDraft();
  return {
    enabled: true,
    endpoint: otel.endpoint,
    authType: otel.auth.type,
    tokenEnv: otel.auth.token_env ?? "",
    serviceName: otel.service_name ?? "",
  };
}

export function otelSourceErrors(draft: OtelSourceDraft): OtelSourceFieldError {
  if (!draft.enabled) return {};
  const error: OtelSourceFieldError = {};
  const endpoint = draft.endpoint.trim();
  if (!endpoint) error.endpoint = "Enter the OTLP traces URL.";
  else if (!isHttpUrl(endpoint)) error.endpoint = "Enter an http or https URL. The importer does not call it.";
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
  return Boolean(errors.endpoint || errors.token_env || errors.service_name);
}

/**
 * `version` is always 1. Bearer auth stores the env var name only.
 * `none` omits `token_env`. A blank service name omits `service_name`.
 */
export function otelSourceFromDraft(draft: OtelSourceDraft): OtelSourceConfig | undefined {
  if (!draft.enabled) return undefined;
  const source: OtelSourceConfig = {
    version: OTEL_SOURCE_VERSION,
    endpoint: draft.endpoint.trim(),
    auth:
      draft.authType === "bearer"
        ? { type: "bearer", token_env: draft.tokenEnv.trim() }
        : { type: "none" },
  };
  const serviceName = draft.serviceName.trim();
  if (serviceName) source.service_name = serviceName;
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
