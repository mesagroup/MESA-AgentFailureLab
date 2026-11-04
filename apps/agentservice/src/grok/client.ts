import OpenAI, { APIConnectionError, APIError } from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { FAULT_CATEGORIES, FIX_KINDS } from "@mesa/shared";
import type {
  DiagnosisModel,
  ModelCompletion,
  ModelCompletionRequest,
  ModelUsage,
} from "../diagnosis/diagnose.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const USD_TICKS = 10_000_000_000;

export class RetryableModelError extends Error {
  readonly name = "RetryableModelError";

  constructor() {
    super("retryable");
  }
}

export class TerminalModelError extends Error {
  readonly name = "TerminalModelError";

  constructor() {
    super("terminal");
  }
}

export interface GrokModelOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** Test double. When omitted, the OpenAI SDK calls the xAI chat completions endpoint. */
  send?: (request: ModelCompletionRequest) => Promise<ModelCompletion>;
}

/**
 * One diagnosis completion. Tries once, and on a timeout or retryable HTTP
 * status tries exactly one more time. `maxRetries` on the SDK stays 0 so the
 * SDK does not add a second retry loop.
 */
export function createGrokModel(options: GrokModelOptions): DiagnosisModel {
  const send = options.send ?? createOpenAiSend(options);
  return {
    async complete(request) {
      try {
        return await once(send, request);
      } catch (error) {
        if (!(error instanceof RetryableModelError)) {
          throw error;
        }
        return await once(send, request);
      }
    },
  };
}

export function readProviderUsage(usage: unknown): ModelUsage | null {
  if (!isRecord(usage)) {
    return null;
  }
  const input = readCount(usage, ["prompt_tokens", "input_tokens"]);
  const output = readCount(usage, ["completion_tokens", "output_tokens"]);
  if (input === null || output === null) {
    return null;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    cost_usd: readCost(usage),
  };
}

export function buildChatRequest(request: ModelCompletionRequest): ChatCompletionCreateParamsNonStreaming {
  return {
    model: request.model,
    temperature: 0,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "Diagnosis",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["category", "cause", "step_id", "confidence", "evidence", "proposed_fixes"],
          properties: {
            category: { type: "string", enum: [...FAULT_CATEGORIES] },
            cause: { type: "string" },
            step_id: { type: "string" },
            confidence: { type: "number" },
            evidence: { type: "array", items: { type: "string" } },
            proposed_fixes: { type: "array", items: { type: "string", enum: [...FIX_KINDS] } },
          },
        },
      },
    },
  };
}

/** True for timeouts, connection failures, and statuses worth one more attempt. */
export function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof RetryableModelError || error instanceof APIConnectionError) {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return error instanceof APIError && error.status !== undefined && RETRYABLE_STATUS.has(error.status);
}

async function once(
  send: (request: ModelCompletionRequest) => Promise<ModelCompletion>,
  request: ModelCompletionRequest,
): Promise<ModelCompletion> {
  try {
    return await send(request);
  } catch (error) {
    if (error instanceof RetryableModelError || error instanceof TerminalModelError) {
      throw error;
    }
    if (isRetryableProviderError(error)) {
      throw new RetryableModelError();
    }
    throw new TerminalModelError();
  }
}

function createOpenAiSend(
  options: GrokModelOptions,
): (request: ModelCompletionRequest) => Promise<ModelCompletion> {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    timeout: options.timeoutMs,
    maxRetries: 0,
  });
  return async (request) => {
    const completion = await client.chat.completions.create(buildChatRequest(request), {
      timeout: options.timeoutMs,
      maxRetries: 0,
    });
    const content = completion.choices[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new TerminalModelError();
    }
    return {
      content,
      usage: readProviderUsage(completion.usage),
    };
  };
}

function readCount(usage: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function readCost(usage: Record<string, unknown>): number | null {
  const ticks = usage.cost_in_usd_ticks;
  if (typeof ticks === "number" && Number.isInteger(ticks) && ticks >= 0) {
    return ticks / USD_TICKS;
  }
  if (typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0) {
    return usage.cost_usd;
  }
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) {
    return usage.cost;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
