-- The coach's token is minted after a sign-in, and only its hash is kept.
--
-- Until now the API had one bearer token, pasted into a generated skill file
-- and uploaded to Claude by hand. The skill is becoming a plugin installed from
-- this repository, and a file in a repository cannot carry a secret. So the
-- secret has to come from somewhere else: Marco signs in with Google through
-- the plugin's connector, and the connector's one tool mints him a token.
--
-- Minted, not passed through. The sign-in token the connector holds could have
-- served as the API's bearer directly, and then this table would not exist.
-- But that token would sit in every transcript for its hour, every API call
-- would have to verify a signature, and the test suite — which runs without
-- the auth service — could never obtain one. A minted token costs one indexed
-- read per request, which is nothing beside the query the request is for; it
-- is revoked by deleting its row; and a test mints one by inserting a row.
--
-- Only the SHA-256 of the token is stored. A read of this table yields nothing
-- a caller could present, which is what lets the email sit beside it in plain
-- text. Expiry is a column, not a job: expired rows are swept the next time a
-- token is minted, because nothing else in this system runs on a schedule and
-- a table that grows by one row a day does not earn one.
--
-- Row level security with no policies, like coach_issues: the function reads
-- this table as the database owner, and nothing else should read it at all.

create table api_tokens (
  token_hash text primary key,
  user_email text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint api_tokens_expires_after_issue check (expires_at > issued_at)
);

comment on table api_tokens is
  'One row per API token the connector minted after a sign-in, keyed by the token''s SHA-256 so the plaintext exists only in the conversation that received it. Expired rows are swept on the next mint.';

alter table api_tokens enable row level security;
