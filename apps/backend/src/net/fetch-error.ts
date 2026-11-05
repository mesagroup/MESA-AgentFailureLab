/**
 * Node's fetch (undici) rejects with `TypeError: fetch failed`.
 * The status, code, and address are on `error.cause`, not `error.message`.
 */

const BARE_FETCH = new Set(["fetch failed", "terminated", "network error", "other side closed"]);

export function describeFetchError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    const text = value?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    parts.push(text);
  };
  walk(error, push, 0);
  return parts.join(": ") || "network error";
}

function walk(error: unknown, push: (value: string | undefined) => void, depth: number): void {
  if (depth > 4 || error == null) return;
  if (typeof error === "string") {
    push(error);
    return;
  }
  if (error instanceof AggregateError) {
    push(error.message);
    const code = stringCode(error);
    if (code) push(code);
    for (const inner of error.errors) walk(inner, push, depth + 1);
    walk(error.cause, push, depth + 1);
    return;
  }
  if (error instanceof Error) {
    push(error.message);
    const code = stringCode(error);
    if (code) push(code);
    walk(error.cause, push, depth + 1);
  }
}

function stringCode(error: object): string | undefined {
  if (!("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" && code.trim().length > 0 ? code.trim() : undefined;
}

/** User-facing text. A bare undici message is expanded with its cause. */
export function publicErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (!message) return fallback;
  if (!BARE_FETCH.has(message)) return message;
  const described = describeFetchError(error);
  return described.length > 0 ? described : message;
}
