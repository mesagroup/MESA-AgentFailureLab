-- Agent registration documents.
-- The JSON Schema packages/shared/schemas/agent.schema.json is the source of truth.
-- This table stores that document. It does not store Runs or Traces.
-- Later files in this directory (002_runs.sql, 003_traces.sql) own those tables.
-- The runner records the file name in schema_migrations and will not apply it again.
-- Keep a shipped file unchanged. Add a new numbered file for the next change.
-- Statements stay idempotent so the file is safe to run by hand as well.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id text PRIMARY KEY,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
