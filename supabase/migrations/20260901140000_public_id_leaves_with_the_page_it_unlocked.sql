-- `sessions.public_id` was the log page's front door, and ADR-0004 retired the
-- page.
--
-- Every session carried twenty-one characters of CSPRNG over sixty-two
-- symbols, because the URL it spelled — `<API base>/s/<public_id>` — was the
-- one surface in this system that carried no token. The unguessable id *was*
-- the authentication. With no page to open, nothing spells that URL and
-- nothing reads the column; it was still being minted for every session and
-- kept forever.
--
-- This is the first field this API stops sending. Everything shipped so far
-- either added one or corrected a declaration to match what was already going
-- out. The break is in the shape alone: no coaching document names
-- `public_id`, and it appears nowhere in `skill/`, so nothing reads what it
-- stops receiving.
--
-- The values do not survive, and that is the point rather than a cost. An id
-- whose only purpose was to guard a page that no longer exists guards nothing,
-- and a shareable session link, if one is ever wanted, would mint its own
-- rather than inherit secrets from a retired one.
alter table sessions drop constraint sessions_public_id_key;
alter table sessions drop column public_id;

-- Three column comments outlived the page they describe. A comment on a
-- Postgres column is changed by a migration and not by an edit, which is why
-- they waited for this one instead of riding along with the deletion. Only the
-- clause naming the page moves in each; the rest is byte-identical.

comment on column sets.request_id is
  'Set on sets appended through POST /sessions/:id/sets, which has no natural key to collide on. Sets created with a session are keyed by (session_id, position) instead and leave this null.';

comment on column exercises.measure is
  'What a set of this exercise records. load_reps = weight and reps (the barbell default). reps = reps alone (push-ups, jump contacts). distance = metres (broad jump). duration = seconds (plank, an easy run logged by time). distance_duration = both together (a sprint, an interval, a tempo run). A property of the exercise, never a per-set choice: a back squat is never measured in metres. It decides which fields a set may carry, and the API validates a set''s fields against it.';

comment on column sets.mesocycle_id is
  'The plan this work serves. Null = off-plan: incidental activity — a hike, a game of five-a-side — recorded as fact and measured against no dose. Resolved server-side when a set is written, never sent by the caller.';
