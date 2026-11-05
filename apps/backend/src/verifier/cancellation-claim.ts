import type { TraceStep } from "@mesa/shared";

/**
 * Deterministic reading of a final answer.
 * A sentence that both cancels and denies, refuses, or says the call did not
 * happen is not a success claim. This is not an LLM judge.
 */
export function claimsOrderCancellation(text: string): boolean {
  const sentences = text.split(/[.!?\n]+/);
  return sentences.some((sentence) => sentenceClaims(sentence));
}

export function cancelOrderSucceeded(
  steps: readonly Pick<TraceStep, "type" | "tool_name" | "tool_output">[],
): boolean {
  return steps.some((step) => {
    if (step.type !== "tool_result" || step.tool_name !== "cancel_order") return false;
    if (!isRecord(step.tool_output)) return false;
    if (typeof step.tool_output.error === "string") return false;
    return step.tool_output.status === "cancelled";
  });
}

export function finalAssistantText(steps: readonly Pick<TraceStep, "type" | "role" | "content">[]): string {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.type === "message" && step.role === "assistant" && typeof step.content === "string") {
      return step.content;
    }
  }
  return "";
}

const DENIAL =
  /\b(not|never|no|unable|cannot|can't|could not|couldn't|did not|didn't|was not|wasn't|without|refused|rejected|denied|blocked|failed|stays placed|still placed)\b/i;

function sentenceClaims(sentence: string): boolean {
  const text = sentence.trim();
  if (!/cancell?ed|cancell?ation/i.test(text)) return false;
  if (DENIAL.test(text)) return false;
  return (
    /\bcancell?ation (succeeded|was successful|is complete|completed)\b/i.test(text) ||
    /\bsuccessfully cancell?ed\b/i.test(text) ||
    /\b(has been|was|is|got) cancell?ed\b/i.test(text) ||
    /\bcancell?ed (the |this |your |that )?order\b/i.test(text) ||
    /\bi (have |'ve )?cancell?ed\b/i.test(text)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
