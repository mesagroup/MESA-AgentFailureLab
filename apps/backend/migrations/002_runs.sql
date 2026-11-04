-- Run documents.
-- The JSON Schema packages/shared/schemas/run.schema.json is the source of truth.
-- `document` is the Run object the API returns. SQL does not restate each field.
-- `created_at` is the first insert time. It is not a Run field. A later save
-- keeps it, so GET /runs stays in first-save order, then run_id.
-- `agent_id` is copied from the document for lookups. There is no foreign key
-- to agents: deleting an agent does not delete its runs.
-- The runner records this file name in schema_migrations and will not apply it again.
-- Keep a shipped file unchanged. Add a new numbered file for the next change.
-- Statements stay idempotent so the file is safe to run by hand as well.

CREATE TABLE IF NOT EXISTS runs (
  run_id text PRIMARY KEY,
  agent_id text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Runs for one agent, oldest first save first. Also covers listRunsByAgent.
CREATE INDEX IF NOT EXISTS runs_agent_id_created_at_idx
  ON runs (agent_id, created_at, run_id);

-- GET /runs orders by first insert, then run_id.
CREATE INDEX IF NOT EXISTS runs_created_at_run_id_idx
  ON runs (created_at, run_id);
