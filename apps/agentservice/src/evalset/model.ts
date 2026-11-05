import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { TASK_EVALSET_VERSION } from "@mesa/shared";
import type { DiagnosisModel, ModelCompletion, ModelCompletionRequest } from "../diagnosis/diagnose.js";
import { TerminalModelError, createGrokModel, readProviderUsage, type GrokModelOptions } from "../grok/client.js";

const EVALSET_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "cases"],
  properties: {
    version: { type: "integer", enum: [TASK_EVALSET_VERSION] },
    cases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["case_id", "expectation", "rubric"],
        properties: {
          case_id: { type: "string" },
          expectation: { type: "string" },
          rubric: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * Same retry wrapper as diagnosis, with an evalset JSON schema instead of Diagnosis.
 * Does not change `buildChatRequest` used by `POST /diagnose`.
 */
export function createEvalsetGrokModel(options: GrokModelOptions): DiagnosisModel {
  return createGrokModel({
    ...options,
    send: options.send ?? createEvalsetOpenAiSend(options),
  });
}

export function buildEvalsetChatRequest(
  request: ModelCompletionRequest,
): ChatCompletionCreateParamsNonStreaming {
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
        name: "TaskEvalset",
        strict: true,
        schema: EVALSET_JSON_SCHEMA,
      },
    },
  };
}

function createEvalsetOpenAiSend(
  options: GrokModelOptions,
): (request: ModelCompletionRequest) => Promise<ModelCompletion> {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    timeout: options.timeoutMs,
    maxRetries: 0,
  });
  return async (request) => {
    const completion = await client.chat.completions.create(buildEvalsetChatRequest(request), {
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
