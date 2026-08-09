-- Bodyweight arrives on its own.
--
-- Until now every weigh-in was a POST somebody had to remember to make, which
-- is the one input the whole nutrition half depends on and the one most likely
-- to lapse. The expenditure back-solve needs three weigh-ins a week before it
-- will produce a number at all; below that it returns insufficient_data and the
-- calorie target stops updating. A habit that has to be performed daily to keep
-- an estimate alive is a habit that will eventually not be performed.
--
-- So the scale reports itself. Marco steps on a Withings Body, Withings posts a
-- content-free notification to /api/withings/notify, and the function calls
-- Withings back with its own credentials to fetch the number. Nothing in the
-- notification is trusted as data — it is a hint about which window to query,
-- and every value comes from an authenticated call in the other direction.
-- That is what makes it safe for the notify route to sit outside the bearer
-- token: Withings cannot send our token, and a forged notification can at worst
-- make the server ask Withings a question it already knows the answer to.
--
-- This table holds the credentials for that call back. It is not a secret in
-- the Supabase sense because it changes: the access token expires every three
-- hours and is replaced, and Withings may replace the refresh token alongside
-- it. A value that rewrites itself cannot live in a deploy-time secret.

create table withings_auth (
  -- One user, one scale, one row. The CHECK is what makes "the row" a
  -- meaningful phrase: without it a second row could appear and every read
  -- would silently pick one of them.
  id smallint primary key default 1,
  withings_user_id text not null,
  device_id text not null,
  access_token text not null,
  refresh_token text not null,
  access_token_expires_at timestamptz not null,
  last_sync_at timestamptz,
  last_sync_attempt_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint withings_auth_single_row check (id = 1)
);

comment on table withings_auth is
  'Credentials and sync watermark for the Withings scale. Exactly one row. Seeded by hand from a refresh token obtained through a one-off browser OAuth flow — there is no authorization flow in this codebase, because it happened once and does not need to happen again.';

comment on column withings_auth.device_id is
  'The scale''s own identifier, as it appears in the deviceid field of a measure group. This is the filter that keeps hand-entered and third-party-imported weights out of the database: a reading from the Body carries this id, and a manual entry carries no device at all. Stored here rather than as a secret because it is an identifier, not a credential, and because it changes if the scale is ever replaced.';

comment on column withings_auth.refresh_token is
  'Replaced on every refresh with whatever Withings returned, whether or not it differs from what was sent. Withings documents that this token rotates; on this account it has been observed not to. Persisting the response unconditionally is correct under both behaviours, and getting it wrong fails in the worst possible way — the integration works for three hours and then stops, silently, with no row appearing and nothing to distinguish that from a day Marco did not weigh himself.';

comment on column withings_auth.last_sync_at is
  'The high-water mark passed back to Withings as lastupdate on the catch-up pass, taken from the updatetime the API itself reported. Advances only after a pass that succeeded: a failed sync must not be able to skip the window it failed on.';

comment on column withings_auth.last_sync_attempt_at is
  'When a catch-up was last attempted, successful or not. Separate from last_sync_at because the two answer different questions: this one throttles (the catch-up rides on the /health ping, which arrives every few minutes), that one bounds the query. Collapsing them into one column would mean a failed attempt either advanced the watermark or disabled the throttle.';

alter table withings_auth enable row level security;

-- bodyweight.source has carried 'manual' since the schema was written and the
-- column was always meant to answer this question; this is the first time it
-- has had a second answer to give.
comment on column bodyweight.source is
  'Where the measurement came from: "manual" for a value Marco read off the scale and told the coach, "withings" for one the scale reported itself. Half of the natural key with measured_at, which is what makes the automatic path safe to run twice — a notification and the daily catch-up can both deliver the same reading and only one row exists.';
