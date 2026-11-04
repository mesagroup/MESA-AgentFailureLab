import { FIX_KINDS, planLibraryTask, type AgentTask, type FixKind } from "@mesa/shared";
import { validateAgentTask } from "@mesa/shared/validate";
import Fastify, { type FastifyInstance } from "fastify";

const TOOL_PERMISSION: Record<string, string> = {
  renew_loan: "write:loan",
  return_loan: "write:loan",
  place_hold: "write:hold",
  get_loan: "read",
};

export interface BuildAppOptions {
  logger?: boolean;
}

/**
 * External library desk.
 * `POST /v1/tasks/run` returns actions with `executed: false`.
 * The harness runs the tools and writes `outcome.verifier`. This process does not.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async () => ({ status: "ok", service: "library-agent", role: "external" }));

  app.post("/v1/tasks/run", async (request, reply) => {
    const parsed = parseRun(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request", message: parsed.message });
    const planned = planLibraryTask(parsed.task, { permissions: parsed.permissions });
    if (!planned.ok) return reply.code(400).send({ error: "unsupported_task", message: planned.message });
    if (!parsed.fixKinds.includes("permission_guard")) {
      return { executed: false, actions: planned.actions, refused: [], embedded: [] };
    }
    const actions = [];
    const refused = [];
    for (const action of planned.actions) {
      const required = TOOL_PERMISSION[action.tool_name] ?? "read";
      if (parsed.permissions.includes(required)) actions.push(action);
      else refused.push({ tool_name: action.tool_name, required });
    }
    return { executed: false, actions, refused, embedded: [] };
  });

  return app;
}

function parseRun(body: unknown):
  | { ok: true; task: AgentTask; permissions: string[]; fixKinds: FixKind[] }
  | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: "Body must be a JSON object." };
  const taskId = requiredString(body.task_id, "task_id");
  if (!taskId.ok) return taskId;
  if (!Array.isArray(body.permissions) || body.permissions.some((entry) => typeof entry !== "string")) {
    return { ok: false, message: "permissions must be an array of strings." };
  }
  const task = validateAgentTask(body.task);
  if (!task.ok) return { ok: false, message: body.task === undefined ? "task is required." : `task is invalid: ${task.errors.join("; ")}` };
  if (task.value.task_id !== taskId.value) return { ok: false, message: "task.task_id must match task_id." };
  const fixKinds: FixKind[] = [];
  if (body.fix_kinds !== undefined) {
    if (!Array.isArray(body.fix_kinds)) return { ok: false, message: "fix_kinds must be an array of strings." };
    for (const kind of body.fix_kinds) {
      if (typeof kind !== "string" || !(FIX_KINDS as readonly string[]).includes(kind)) {
        return { ok: false, message: `Unknown fix kind ${String(kind)}.` };
      }
      const fix = kind as FixKind;
      if (!fixKinds.includes(fix)) fixKinds.push(fix);
    }
  }
  return { ok: true, task: task.value, permissions: body.permissions as string[], fixKinds };
}

function requiredString(value: unknown, key: string): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, message: `${key} must be a non-empty string.` };
  return { ok: true, value: value.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
