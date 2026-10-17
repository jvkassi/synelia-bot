/**
 * Synelia phase 0: the tables that replace CopilotKit Intelligence's durable threads.
 *
 * Created with `CREATE TABLE IF NOT EXISTS` at boot rather than through a Drizzle migration, so the
 * upstream migration journal stays untouched and a merge from OpenBot never conflicts on it. Phase 1
 * moves these into a proper Drizzle migration once the DDL is reviewed (Backend Expert).
 *
 * `synelia_thread` is the thread index the plan calls `thread_index`; `synelia_thread_run` is the
 * run journal (compacted AG-UI events + message snapshot, seq-ordered, provider/model per run).
 */
export const LOCAL_PERSISTENCE_DDL = `
CREATE TABLE IF NOT EXISTS synelia_thread (
  id            text PRIMARY KEY,
  user_id       text NOT NULL,
  agent_id      text NOT NULL,
  name          text,
  archived      boolean NOT NULL DEFAULT false,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_run_at   timestamptz
);
CREATE INDEX IF NOT EXISTS synelia_thread_user_agent_idx
  ON synelia_thread (user_id, agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS synelia_thread_run (
  run_id         text PRIMARY KEY,
  thread_id      text NOT NULL REFERENCES synelia_thread(id) ON DELETE CASCADE,
  agent_id       text NOT NULL,
  parent_run_id  text,
  seq            bigserial,
  status         text NOT NULL DEFAULT 'done',
  events         jsonb NOT NULL DEFAULT '[]'::jsonb,
  messages       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS synelia_thread_run_thread_idx
  ON synelia_thread_run (thread_id, seq);
-- Which provider/model the run was asked to use (from the "Synelia model" AG-UI context entry;
-- the Mastra Bot only honours allowlisted ids and otherwise uses its default).
ALTER TABLE synelia_thread_run ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE synelia_thread_run ADD COLUMN IF NOT EXISTS model text;
-- Assistant messageIds the run wrote (TEXT_MESSAGE_START / TEXT_MESSAGE_CHUNK), in order; filled at
-- write time, backfilled once for older rows. Serves the per-thread "model under each answer" map.
ALTER TABLE synelia_thread_run ADD COLUMN IF NOT EXISTS message_ids text[];
CREATE INDEX IF NOT EXISTS synelia_thread_run_message_ids_idx
  ON synelia_thread_run USING GIN (message_ids);
UPDATE synelia_thread_run r SET message_ids = COALESCE((
  SELECT array_agg(id ORDER BY first) FROM (
    SELECT e.value->>'messageId' AS id, min(e.ordinality) AS first
    FROM jsonb_array_elements(r.events) WITH ORDINALITY e
    WHERE e.value->>'type' IN ('TEXT_MESSAGE_START', 'TEXT_MESSAGE_CHUNK')
      AND e.value->>'messageId' IS NOT NULL
    GROUP BY 1) ids), '{}')
WHERE r.message_ids IS NULL;

CREATE TABLE IF NOT EXISTS synelia_thread_lock (
  thread_id   text PRIMARY KEY,
  run_id      text NOT NULL,
  expires_at  timestamptz NOT NULL
);
`;
