-- Revisions are idempotent creating writes (§8). Each revision writes exactly
-- one decision row, so the decision is where the revision's request_id lives.
alter table mesocycle_decisions add column request_id uuid;
alter table mesocycle_decisions
  add constraint mesocycle_decisions_request_id_key unique (request_id);
