-- The token belongs to a subject, not an email.
--
-- The sign-in moved to a hosted authorization server, and what its access
-- token reliably carries is a user id — the JWT's `sub` claim, like
-- user_01H… — not an email. The row that records who a minted token was
-- issued to has to name the thing that was actually checked, so the column
-- is renamed to the claim's own word. "subject" rather than user_id: this
-- schema has no users table, and the JWT vocabulary survives a change of
-- provider where a provider's naming would not.
--
-- Renamed rather than added, because the only reader is the code that mints
-- and checks tokens, and a column called user_email holding user_01H… would
-- lie to the next reader. The rows are deleted rather than migrated: every
-- one was minted under the sign-in that is being retired, none should outlive
-- it, and the static token still works, so nobody is locked out by this.

delete from api_tokens;

alter table api_tokens rename column user_email to subject;

comment on column api_tokens.subject is
  'The sign-in server''s id for the person the token was minted for — the access token''s sub claim, like user_01H…. Never an email: the email is not something the sign-in server promises to put in a token, and the id is.';
