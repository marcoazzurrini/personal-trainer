-- The coach reports friction as a GitHub issue, and a retry must not file it
-- twice.
--
-- Every other creating POST in this API keeps its retry guarantee against a
-- row that is already there: blocks, sets and user_context carry a request_id,
-- bodyweight collides on its natural key. An issue lives on GitHub, which has
-- no natural key and no idempotency of its own — post the same report twice
-- and there are two issues. The failure is the ordinary one and the reason
-- request_id exists at all: the function answers, the response is lost on a
-- mobile connection, and the coach retries what it believes failed. Marco
-- then reads the same complaint twice and has to work out that they are one.
--
-- This table is the ledger that makes the retry a no-op. It holds only what
-- answering a retry needs; GitHub holds the issue itself. Written after
-- GitHub confirms the issue, so a row here means the issue exists. The
-- reverse gap — issue created, insert lost — leaves an orphan that a retry
-- would duplicate, and closing it would mean reserving the id before the
-- call and reconciling the failures. That is more machinery than a duplicate
-- issue costs, and it is not the failure that actually happens.

create table coach_issues (
  request_id uuid primary key,
  issue_number integer not null,
  url text not null,
  kind text not null,
  title text not null,
  created_at timestamptz not null default now()
);

comment on table coach_issues is
  'One row per issue the coach filed through POST /issues, keyed by the caller''s request_id so a retry returns the original issue instead of filing a second. Not a copy of the issue: GitHub is the record, this is only enough to answer the retry.';

alter table coach_issues enable row level security;
