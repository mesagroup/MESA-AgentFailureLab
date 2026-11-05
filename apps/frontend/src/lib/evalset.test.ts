import assert from "node:assert/strict";
import test from "node:test";
import { TASK_EVALSET_VERSION, type AgentTask } from "@mesa/shared";
import {
  applyProposedEvalset,
  buildEvalsetGenerateBody,
  evalsetAiErrorText,
  isEvalsetProposal,
} from "./evalset.ts";

class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

test("generate omits the current evalset and revise keeps it", () => {
  const task = filled();
  task.evalset = {
    version: TASK_EVALSET_VERSION,
    cases: [{ case_id: "keep", expectation: "Cite the search." }],
  };
  const generate = buildEvalsetGenerateBody(task, { mode: "generate", instruction: "  " });
  assert.equal(generate.mode, "generate");
  assert.equal(generate.task.evalset, undefined);
  assert.equal(generate.instruction, undefined);
  assert.equal(task.evalset?.cases[0]?.case_id, "keep");

  const revise = buildEvalsetGenerateBody(task, {
    mode: "revise",
    instruction: "Mention the product page.",
    docs: { prompt_summary: "Shop agent", tools: [], constraints: [], config_notes: "" },
  });
  assert.equal(revise.mode, "revise");
  assert.equal(revise.task.evalset?.cases[0]?.case_id, "keep");
  assert.equal(revise.instruction, "Mention the product page.");
  assert.equal(revise.docs?.prompt_summary, "Shop agent");
});

test("a proposal lands on the task without dropping other fields", () => {
  const task = filled();
  applyProposedEvalset(task, {
    version: TASK_EVALSET_VERSION,
    cases: [
      { case_id: "claim", expectation: "Cite the catalog search." },
      { case_id: "tools", expectation: "A product read happens before the claim.", rubric: "Point at the tool step." },
    ],
  });
  assert.equal(task.prompt, "Find the ceramic mug and open it.");
  assert.equal(task.evalset?.version, TASK_EVALSET_VERSION);
  assert.equal(task.evalset?.cases[1]?.rubric, "Point at the tool step.");
  assert.equal(isEvalsetProposal({ evalset: task.evalset }), true);
  assert.equal(isEvalsetProposal({ evalset: { version: 2, cases: [] } }), false);
});

test("AI errors stay local and tell the operator CRUD still works", () => {
  const missing = evalsetAiErrorText(new ApiError(503, "evalset_unavailable", "evalset_unavailable"));
  assert.match(missing.message, /not configured/);
  assert.match(missing.message, /save the Agent/);
  assert.equal(missing.details, "HTTP 503 evalset_unavailable");

  const timeout = evalsetAiErrorText(new ApiError(504, "evalset_timeout", "evalset_timeout"));
  assert.match(timeout.message, /timed out/);
  assert.match(timeout.message, /not changed/);

  const invalid = evalsetAiErrorText(
    new ApiError(502, "/cases/0/expectation must NOT have fewer than 1 characters", "invalid_evalset"),
  );
  assert.match(invalid.message, /expectation/);
  assert.equal(invalid.details, "HTTP 502 invalid_evalset");

  const task = evalsetAiErrorText(new ApiError(400, "/prompt must NOT have fewer than 1 characters", "invalid_task"));
  assert.match(task.message, /prompt/);
});

function filled(): AgentTask {
  return {
    task_id: "task-1",
    title: "Open the mug",
    prompt: "Find the ceramic mug and open it.",
    setup: { cart: [], orders: [], permissions: ["read"] },
    success_test: {
      type: "verifier_checks",
      checks: [{ name: "catalog_read", description: "The session searched the catalog." }],
    },
  };
}
