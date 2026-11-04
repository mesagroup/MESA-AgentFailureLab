export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Text safe to show as the primary error. Status codes stay in `apiErrorDetails`. */
export function friendlyApiMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === "world_busy") {
      return "A run is already in progress. Wait for it to finish, then try again.";
    }
    if (
      error.status === 503 &&
      (error.code === "grok_not_configured" ||
        error.code === "diagnosis_unavailable" ||
        error.code === "diagnosis_not_configured")
    ) {
      return "Grok is not configured. Add an API key on the agent service before diagnosing a trace.";
    }
    if (error.message.trim().length > 0 && error.message !== error.code) return error.message;
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "The request failed.";
}

/** Raw status for the expandable details. Null when there is nothing technical to add. */
export function apiErrorDetails(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  return error.code ? `HTTP ${error.status} ${error.code}` : `HTTP ${error.status}`;
}
