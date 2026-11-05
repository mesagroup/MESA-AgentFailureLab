-- Per-source cursor for POST /agents/:agentId/traces/pull.
-- last_pull_at is the server time of the last successful pull for that source.
-- It is not a Trace field and not an Agent field. A reset deletes these rows
-- together with runs and traces, so the next pull omits `since` and reads the
-- endpoint buffer again.
-- The runner records this file name in schema_migrations and will not apply it again.
-- Keep a shipped file unchanged. Add a new numbered file for the next change.
-- Statements stay idempotent so the file is safe to run by hand as well.

CREATE TABLE IF NOT EXISTS otel_pull_cursors (
  agent_id text NOT NULL,
  source text NOT NULL,
  last_pull_at timestamptz NOT NULL,
  PRIMARY KEY (agent_id, source),
  CONSTRAINT otel_pull_cursors_source_check CHECK (source IN ('prod', 'test'))
);
