-- Make the documented retry guarantee true.
--
-- docs/index has always promised: "Every creating POST takes a request_id.
-- Retrying with the same id can never duplicate, so a retry is always safe."
-- It was opt-in. Where the column existed the API accepted the call without
-- it and wrote the row anyway; on three tables the column did not exist at all.
--
-- The client is an LLM issuing curl over a mobile connection. The failure this
-- prevents is the one that actually happens: a request succeeds, the response
-- is lost, the model retries what it believes failed, and the day silently
-- carries two breakfasts or the session two identical sets. Nothing downstream
-- can detect that afterwards — a duplicated meal is indistinguishable from
-- having eaten twice.
--
-- Three tables gain the column here. The routes that write them append rather
-- than upsert, so a retry genuinely duplicated:
--   blocks        — a second training block
--   user_context  — a second row on the same topic
--   sets          — POST /sessions/:id/sets appends at max(position)+1
--
-- Deliberately not given one: bodyweight (deduped on its measured_at/source
-- natural key), day_flags (on conflict do nothing), exercises and muscles and
-- the alias tables (unique names collide), and the log page's set writes
-- (upsert on session_id/position). Those cannot duplicate, so a request_id
-- would be ceremony rather than a guarantee.

alter table blocks add column request_id uuid,
  add constraint blocks_request_id_key unique (request_id);

alter table user_context add column request_id uuid,
  add constraint user_context_request_id_key unique (request_id);

alter table sets add column request_id uuid,
  add constraint sets_request_id_key unique (request_id);

comment on column sets.request_id is
  'Set on sets appended through POST /sessions/:id/sets, which has no natural key to collide on. Sets created with a session, or written through the log page, are keyed by (session_id, position) instead and leave this null.';
