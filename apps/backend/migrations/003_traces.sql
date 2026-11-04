-- Trace documents.
-- The JSON Schema packages/shared/schemas/trace.schema.json is the source of truth.
-- `document` is the Trace object the API returns. SQL does not restate each field.
-- `run_id`, `agent_id`, and `started_at` are copied from the document.
-- `started_at` is the attempt clock from the trace. `created_at` is the first
-- insert time and is not a Trace field. A later save keeps `created_at`, so
-- GET /traces stays in first-save order, then trace_id.
-- There is no foreign key to runs or agents. Saving a trace does not require
-- the run row, matching the in-memory store.
-- The runner records this file name in schema_migrations and will not apply it again.
-- Keep a shipped file unchanged. Add a new numbered file for the next change.
-- Statements stay idempotent so the file is safe to run by hand as well.

CREATE TABLE IF NOT EXISTS traces (
  trace_id text PRIMARY KEY,
  run_id text NOT NULL,
  agent_id text NOT NULL,
  document jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Traces for one run, oldest first save first.
CREATE INDEX IF NOT EXISTS traces_run_id_created_at_idx
  ON traces (run_id, created_at, trace_id);

-- GET /traces orders by first insert, then trace_id.
CREATE INDEX IF NOT EXISTS traces_created_at_trace_id_idx
  ON traces (created_at, trace_id);
