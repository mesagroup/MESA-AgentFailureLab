import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import { validateAgentTasks, validateOtelSource, validateTaskChecks } from "./checks.js";
import type { Agent, AgentTask, Run, Trace } from "./types.js";

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");

/** Enough of a schema document for the drift checks in the package tests. */
export interface SchemaDocument {
  $defs?: Record<string, { enum?: string[] }>;
  properties?: Record<string, { enum?: string[] }>;
}

function loadSchema(name: string): SchemaDocument {
  const parsed: unknown = JSON.parse(readFileSync(join(schemaDir, name), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Schema ${name} is not a JSON object.`);
  }
  return parsed as SchemaDocument;
}

export const traceSchema = loadSchema("trace.schema.json");
export const agentSchema = loadSchema("agent.schema.json");
export const runSchema = loadSchema("run.schema.json");
export const otelImportSchema = loadSchema("otel-import.schema.json");

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

// These CJS builds are both the constructor/function and `module.exports.default`.
// TypeScript types the default import as the module namespace, so call `.default`.
const ajv = new Ajv2020Module.default({ allErrors: true, strict: true });
addFormatsModule.default(ajv);

const AGENT_SCHEMA_ID =
  "https://github.com/mesagroup/MESA-AgentFailureLab/packages/shared/schemas/agent.schema.json";

const validateTraceSchema: ValidateFunction = ajv.compile(traceSchema as AnySchema);
const validateAgentSchema: ValidateFunction = ajv.compile(agentSchema as AnySchema);
const validateRunSchema: ValidateFunction = ajv.compile(runSchema as AnySchema);
const validateOtelImportSchema: ValidateFunction = ajv.compile(otelImportSchema as AnySchema);
const validateTaskSchema: ValidateFunction = ajv.compile({ $ref: `${AGENT_SCHEMA_ID}#/$defs/task` });

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const where = error.instancePath.length > 0 ? error.instancePath : "/";
    return `${where} ${error.message ?? "invalid"}`;
  });
}

function check<T>(validate: ValidateFunction, data: unknown): ValidationResult<T> {
  if (validate(data)) {
    return { ok: true, value: data as T };
  }
  return { ok: false, errors: formatErrors(validate.errors) };
}

export function validateTrace(data: unknown): ValidationResult<Trace> {
  return check(validateTraceSchema, data);
}

export function validateAgent(data: unknown): ValidationResult<Agent> {
  const structural = check<Agent>(validateAgentSchema, data);
  if (!structural.ok) return structural;
  const taskErrors = validateAgentTasks(structural.value);
  const otelErrors = validateOtelSource(structural.value);
  const errors = [...taskErrors, ...otelErrors];
  if (errors.length > 0) return { ok: false, errors };
  return structural;
}

/** One task, including its setup and the registered check params. */
export function validateAgentTask(data: unknown): ValidationResult<AgentTask> {
  const structural = check<AgentTask>(validateTaskSchema, data);
  if (!structural.ok) return structural;
  const taskErrors = validateTaskChecks(structural.value);
  if (taskErrors.length > 0) return { ok: false, errors: taskErrors };
  return structural;
}

export function validateRun(data: unknown): ValidationResult<Run> {
  return check(validateRunSchema, data);
}

/** Structural check for an OTel import batch. The mapper still applies field rules and `validateTrace`. */
export function validateOtelImport(data: unknown): ValidationResult<unknown> {
  return check(validateOtelImportSchema, data);
}
