import { OTEL_SOURCE_VERSION, type OtelSourceConfig } from "@mesa/shared";

/** Form fields for the optional `Agent.otel` dual source. `enabled` false omits the field on save. */
export interface OtelSourceDraft {
  enabled: boolean;
  prodEndpoint: string;
  testEndpoint: string;
  serviceName: string;
}

export interface OtelSourceFieldError {
  prod_endpoint?: string;
  test_endpoint?: string;
  service_name?: string;
}

export function emptyOtelDraft(): OtelSourceDraft {
  return {
    enabled: false,
    prodEndpoint: "",
    testEndpoint: "",
    serviceName: "",
  };
}

export function otelDraftFromAgent(otel: OtelSourceConfig | undefined): OtelSourceDraft {
  if (!otel) return emptyOtelDraft();
  return {
    enabled: true,
    prodEndpoint: otel.prod.endpoint,
    testEndpoint: otel.test.endpoint,
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
  if (draft.serviceName.length > 0 && draft.serviceName.trim().length === 0) {
    error.service_name = "Enter a service name, or leave it blank.";
  }
  return error;
}

export function otelSourceHasErrors(errors: OtelSourceFieldError): boolean {
  return Boolean(errors.prod_endpoint || errors.test_endpoint || errors.service_name);
}

/**
 * Lab MVP writes `auth.type: none` only (no bearer UI).
 * Keeps existing `schema_id` so Save does not strip the lab remap.
 */
export function otelSourceFromDraft(
  draft: OtelSourceDraft,
  options?: { preserveSchemaId?: string },
): OtelSourceConfig | undefined {
  if (!draft.enabled) return undefined;
  const auth = { type: "none" as const };
  const serviceName = draft.serviceName.trim();
  const prod = { endpoint: draft.prodEndpoint.trim(), auth };
  const test = { endpoint: draft.testEndpoint.trim(), auth };
  const source: OtelSourceConfig = {
    version: OTEL_SOURCE_VERSION,
    prod: serviceName ? { ...prod, service_name: serviceName } : prod,
    test: serviceName ? { ...test, service_name: serviceName } : test,
  };
  const schemaId = options?.preserveSchemaId?.trim();
  if (schemaId) source.schema_id = schemaId;
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
