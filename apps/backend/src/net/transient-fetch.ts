import { describeFetchError } from "./fetch-error.js";

/**
 * Extra wait for a connect failure or a fast 502/503/504.
 * A call that already ran for several seconds is not tried again:
 * that would repeat a Grok turn that reached the model.
 */
export const TRANSIENT_FETCH_BUDGET_MS = 20_000;

const FAST_ATTEMPT_MS = 8_000;
const WAKE_STATUSES = new Set([502, 503, 504]);

export interface TransientFetchOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
  /** Shown in the error, for example "Agent service /v1/tasks/run". */
  label: string;
}

/** A fast 502/503/504 from our own handler is a finished call, not a cold proxy. */
async function isProxyWake(response: Response): Promise<boolean> {
  if (!WAKE_STATUSES.has(response.status)) return false;
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  if (text.trim().length === 0) return true;
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (body.error === "grok_agent_failed" || body.error === "diagnosis_failed") return false;
  } catch {
    return true;
  }
  return true;
}

function delayMs(attempt: number): number {
  return Math.min(4_000, 400 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Retry while the other Render service is unreachable or still waking.
 * Network errors and fast 502/503/504 stay inside `budgetMs`.
 */
export async function fetchWithTransientRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  options: TransientFetchOptions,
): Promise<Response> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const budget = options.budgetMs ?? TRANSIENT_FETCH_BUDGET_MS;
  const started = now();
  let attempt = 0;
  let lastError: unknown;
  while (true) {
    if (init?.signal?.aborted) break;
    attempt += 1;
    const attemptStarted = now();
    try {
      const response = await fetchImpl(url, init);
      const fast = now() - attemptStarted < FAST_ATTEMPT_MS;
      const waking = fast && (await isProxyWake(response));
      if (!waking || now() - started >= budget) return response;
      await response.body?.cancel().catch(() => undefined);
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
      const fast = now() - attemptStarted < FAST_ATTEMPT_MS;
      if (!fast || now() - started >= budget || init?.signal?.aborted) break;
    }
    const remaining = budget - (now() - started);
    if (remaining <= 0) break;
    await sleep(Math.min(delayMs(attempt), remaining));
  }
  throw new Error(`${options.label} failed: ${describeFetchError(lastError)}`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}
