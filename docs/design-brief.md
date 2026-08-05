# AI Personal Trainer — Design Brief

Replaces the earlier brief of the same name. Everything here reflects decisions made up to
5 August 2026, including the full API review.

Three kinds of statement appear below, always labelled:

- Unlabelled — decided. Don't reopen without a reason.
- **OPEN** — not decided yet.
- **PROPOSAL** — suggested but never ruled on. Treat as undecided.

Write plainly when replying about this project. Short sentences, no invented jargon. Don't
introduce tables or columns that aren't in this document without saying clearly that they're
new proposals.

No code has been written yet. This is design only.

---

## 1. What this is

Claude acts as a personal trainer. It plans the training, writes each session, receives what
was actually done, and answers questions about progress.

Three pieces:

- An **API in front of a SQL database** holding the training data.
- A **web page** for logging sets during a workout.
- A **Claude skill** — one small entry file that fetches its other documents from the API at
  runtime, so updating them is a git push rather than repackaging the skill.

Everything conversational happens in the Claude desktop and iOS apps.

**Hosting and database: Supabase.** Postgres, with Edge Functions on Deno for the API.
Chosen over Cloudflare Workers + D1 after workerd friction; Deno is a real runtime, cold
starts are low, and the free tier is enough for one user.

One known trap: Supabase pauses free projects after a week of database inactivity, and a
paused project must be unpaused manually from the dashboard — it does not wake on request.
The keep-alive is a **free external uptime monitor** (UptimeRobot or similar) pinging one
endpoint every few minutes — part of the build, not an optional extra. Not a GitHub Actions
cron: GitHub silently disables scheduled workflows after 60 days without repo activity, so
the cron would die in exactly the scenario it exists to protect against. The monitor never
decays, and emails on failure for free.

What Supabase offers that this project deliberately does not use: the auto-generated REST
API over tables (the API here is custom-shaped on purpose), row-level security (one user, no
auth accounts), realtime subscriptions, and JSON columns (the schema is deliberately
relational). Future-you: don't get tempted.

---

## 2. The rule that shapes everything

**The database stores facts. The markdown documents hold the judgment.**

The database records what exercises exist, what muscles they train, what is planned, and what
was done. Queries count things. Nothing in the database or the API decides anything about
training.

How much weight to add, when to deload, how many sets belong in one session, whether a
mesocycle is working — that is knowledge, and it lives in the skill's documents. Claude applies
it by reading the data. There is no rules table and no code that works out a next weight.

This came up repeatedly. An earlier version had progression rules in the database, and the
result was an API replying "put 110 kg on the bar" — the coach's job, not the database's.

Three things follow:

- **Don't store calculated values.** Sets per muscle, weekly volume, personal records,
  estimated maxes, tonnage, adherence — work them out in a query when asked. Stored numbers go
  stale and then need invalidating. (SQL views are fine: a view computes at read time, it
  stores nothing. See §7.)
- **The log page has no logic.** It renders what the API sends and posts back what was typed.
- **Reads return facts, never suggestions.** Never a recommended weight.

Two further rules, learned the hard way during this design:

- **No number appears in two places.** If a figure is in a table, prose must not restate it,
  and vice versa. Every redundancy so far has been the source of a design problem.
- **Store the numbers a policy produced, not the policy.** A pair of columns implying a
  progression shape is a rule hiding in a schema. A list of numbers is data.

---

## 3. Who it's for

One person. No accounts, no permissions. Trains at home with a barbell and plates, phone in
hand. Logs on paper today and wants to stop.

There is a `users` table, but for holding facts about the athlete, not for multi-user support.
See §7.

---

## 4. What a coach does, and what that means here

Six jobs. The API and the schema are derived from these, not from the tables.

1. **Know the athlete** — goals, injuries, equipment, what he'll refuse to do.
2. **Set the plan** for a period, with targets that make it falsifiable.
3. **Decide today's work**, given the plan and today's reality.
4. **Observe the work** as it's done.
5. **Judge whether it's working**, and change the plan or hold.
6. **Remember why** every choice was made.

Jobs 5 and 6 are what separate a coach from a workout logger.

The use cases that follow from them:

**Setting up.** Once. Goals, training history, current numbers, equipment, days available,
what they will and won't do. Load the exercise list. Create the first block and mesocycle —
the mesocycle arrives complete, plan and all, in one call (§8).

**Asking what to do today.** The most important one. Claude reads the mesocycle, what's been
done recently, when each exercise was last trained, and what the user says about today, then
writes the session and saves a note explaining why it looks like that.

**Logging.** Set by set, on the web page. Shows the target and last time's numbers before each
set. Allows extra sets, adding an exercise picked from the catalogue, stopping early.

**Talking about it afterwards.** How it went, anything notable, what it means for next time.

**Asking questions.** "Am I doing enough for glutes." "Is my bench moving." "Am I on track."
"Why did we drop squat volume three weeks ago."

**Reviewing the mesocycle.** Compare what was planned against what happened — two reads and a
diff, planned rows against the delivered-per-exercise view (§7, §8). Continue, change
something, or end it. Save the decision and the reason.

**Adding context over time.** "My shoulder is sore." "I've stopped doing X because Y." Goals
change. This arrives constantly and in no fixed shape.

**Fixing mistakes.** "That was 8 reps not 9." "I trained Tuesday and forgot to log it." Past
data must be editable, and a forgotten session can be created after the fact — see
retro-logging in §8.

**Later, not now.** Running, calories, watch data, body measurements.

### What can't be recovered later

Why a session looked the way it did, and why a decision was made. Weights and reps could be
worked out again; the reasoning couldn't. Save it every time.

---

## 5. How training is planned

### Blocks and mesocycles

A **block** is the long horizon — a goal and a date range. It stays thin: name, goal, start,
end.

A **mesocycle** sits inside a block and is the unit that actually holds a plan. Roughly 4–8
weeks. It has an intent in prose, a number of planned weeks, an intended number of sessions per
week, a fixed list of exercises, weekly planned sets, and load targets.

**The mesocycle is the phase.** Accumulation is one mesocycle, intensification is another, a
deload is another, all sequenced inside the block. There is no phase column anywhere. For a
plain hypertrophy run the layer adds little and two mesocycles in a block will do; for strength
work — accumulation into intensification, Smolov, Gruzza's MAV — it's what makes the structure
expressible.

There is **no weekly plan and no movement-pattern layer**. "Three sessions a week" is a number
Claude is given when writing a session. Nothing schedules anything. Progressive overload is
tracked per exercise, because front squat and back squat use different weights and grouping
them would make progress meaningless.

### What a week is

A week is **Monday to Sunday, Europe/Rome**. Mesocycles **start on a Monday** and run whole
weeks, so they end on a Sunday. No partial weeks. This makes "week N" unambiguous, keeps the
first week comparable to every other week in planned-versus-delivered numbers, and leaves no
gap days between mesocycles. Postgres agrees: `date_trunc('week', ...)` is ISO, Monday-start.

### Planned sets: one row per exercise per week

`mesocycle_weekly_exercise_sets` holds the planned working sets for each exercise in each week.
That single table carries the whole progression.

This replaced two things: a per-muscle volume target table, and a `sets_first_week` /
`sets_final_week` column pair on the exercise list. Both are gone.

Why the column pair had to go: two columns imply one progression shape — add sets linearly.
A strength mesocycle, a wave, a flat maintenance run or anything else would leave them empty or
demand new columns. Rows of weekly numbers express any shape without a rule in the schema.

Why the grain is per exercise and not per muscle: sets per exercise sum through
`exercise_muscles` to give sets per muscle. The reverse can't be recovered. Storing the muscle
level instead threw information away for nothing. **Sets per muscle is always a query, never a
stored number.**

A deload mesocycle is simply one with low numbers in these rows. Nothing special marks it.

### Two kinds of target, and why both are needed

**Planned sets** are the dose you commit to delivering, per exercise per week. Delivering them
only means the work got done.

**Load targets** are per exercise — "back squat 105 × 5 by week 5". These are the outcome.
Growth can't be measured week to week, so performance is the proxy.

Both are needed because either alone can't tell you what happened:

- Planned sets missed → the work wasn't done. The plan was never tested.
- Sets delivered but performance flat → the work was done and produced nothing. Now the plan is
  the problem.

That's the whole review mechanism. Targets are written before the mesocycle starts.

Load targets stay at mesocycle level and are not broken down by week. You can commit to
delivering volume; you cannot commit to hitting a weight on a given day, and putting one in a
table week by week turns a proxy into a prescription you then grind at. Percentage-based
programmes that do prescribe weekly weights are still expressible — the weight lands in
`sets.target_weight` when the session is generated, computed by Claude from the mesocycle intent
and the coaching docs.

The running weekly signal is finer than the end-of-mesocycle number: reps at working weights
creeping up. If that flattens for two or three weeks while sets are being delivered, that's the
signal — don't wait until the last week.

### Rep ranges

`rep_low` and `rep_high` live on the exercise's row in the mesocycle, nullable. They're a
constraint that holds for the whole mesocycle, not something that swings week to week — which
is the point of double progression: work up the range at a fixed weight, and when you reach the
top, add weight and drop back to the bottom.

They are not the same case as the deleted set columns. Those encoded how a number changes over
time, which is a rule. A range is a constraint. The rule that acts on it lives in the coaching
docs.

A mesocycle that doesn't work this way leaves them null. A fixed-rep programme writes 5 and 5.

### Intent says why, tables say how much

The mesocycle's `intent` column is prose and states purpose — "push quad and glute volume hard
while holding upper body". It must not restate the arithmetic. If it says "start at 10 and
build to 18", those numbers now exist in two places and can drift apart.

### No templates, no fixed week

Sessions are generated fresh each time. There is no "Monday is session A". Claude reads the
mesocycle, recent training, when each exercise was last done, and what the user says about
today.

Why: progress is tracked per exercise, not per session, so named sessions gain nothing. And
this user has a history of treating templates as appointments and feeling like a missed Monday
is a failure.

The fixed exercise list matters for a different reason: without it, exercise choice drifts, and
nothing gets done often enough to improve.

### Changing the plan mid-mesocycle

The plan tables hold **only what is currently true**. No `added_on`, no `removed_on`, no
targets left dangling against exercises that are no longer in the plan.

When something changes, the rows change and one row goes into the decision log saying what
changed and why. Example: back squat comes out in week 3 because the lower back keeps flaring.
Its row in the exercise list is deleted, its load target is deleted, its remaining weekly rows
are deleted, leg press rows are inserted, and one decision row records the lot.

All of that happens in **one API call and one database transaction** — the revision endpoint
in §8. A revision is all-or-nothing, and it is rejected without a decision attached. There is
no way to change the plan without saying why.

This is safe because `sets` reference `exercises`, never the mesocycle's plan tables. Deleting
a plan row touches no training history. Every squat ever done is still there and still counted.

What is given up: the plan can't be reconstructed programmatically as it stood on a past date.
The history is prose and has to be read. In practice "why did volume drop three weeks ago" wants
prose anyway.

**Don't make up missed work later.** If a week comes up short, it comes up short. Piling missed
work onto the next week turns one bad week into a spiral and makes it impossible to tell
afterwards whether the plan worked or just wasn't done.

---

## 6. How work is counted

### Warmup or working

Every set is one or the other. The plan says which. Warmups never count.

### Effort

Every working set records how it felt: **easy / hard / to failure**. Three options, tapped on
the log page, required. Since logging through chat is also allowed, the requirement is
enforced in the database, not just on the page: a `CHECK` on `sets` rejects a performed
working set with no effort. No path in can skip it, so there are no unrated sets.

Not a 0–5 scale. People's estimates of reps left are off by about one rep anyway, so finer
numbers would be false precision.

**Effort does not decide whether a set counts.** An easy working set is still a working set.
Effort is information for the coach: if working sets keep coming back easy, the weights are too
light and Claude should say so.

### Which muscles a set counts for

Only muscles worked close to failure by that exercise. It's 1 or 0, never a fraction:

- Back squat — 1 for quads, 0 for glutes.
- Overhead press — 1 for shoulders, 0 for triceps.
- Split squat — 1 for quads **and** 1 for glutes, because both get close to failure.

Reasoning: if a set with four reps left doesn't count, a muscle that had four reps left during
that set shouldn't count either. The known limitation is that this ignores dirty volume.

The separate `fatigue` value handles the rest. Squats do tire the glutes without counting as
glute sets — that's `counts 0, fatigue some`. Fatigue never appears in volume numbers; it's
there so Claude knows what's already been worked when deciding what to add.

When the starting catalogue is written, apply the "goes near failure" test uniformly across
all ~50 exercises in one sitting — the counts are only comparable if the judgment behind them
is consistent.

### Never add muscle counts together

One set can count for two muscles. Six sets of split squats is six sets, not twelve. Any query
grouped by muscle returns one row per muscle and never a total. Totals come from the sets.

### Reclassifying

Changing `exercise_muscles` retroactively changes every past volume number. That's accepted —
if the view of the world changed, the numbers should change with it.

Don't reclassify mid-mesocycle. Between mesocycles.

### Jumps and sprints

`exercises.stimulus_type` — strength / power / conditioning. Only strength counts toward muscle
sets, otherwise a jumping session inflates quad volume. The same column keeps running out of
the numbers later.

---

## 7. The schema

Postgres conventions throughout: primary keys are `bigint generated always as identity`;
real `boolean` columns; `date` for calendar dates and `timestamptz` for instants (instants in
UTC, calendar logic in Europe/Rome); `CHECK` constraints on the small fixed lists — plain
`CHECK`, not Postgres enums, which are a heavier tool than three-value columns deserve;
**no `ON DELETE CASCADE` anywhere**. The cascade ban was born as a D1 workaround and survives
on merit: deleting a plan row must never be able to touch training history, and with no
cascades a wrong delete fails loudly instead of propagating.

Naming rule: every table owned by a mesocycle keeps the `mesocycle_` prefix. Either they all
carry it or none of the ones holding a mesocycle reference do — consistency matters more than
brevity, and the prefix is not a problem.

### The athlete

**users** — the things that don't change. `id`, `name`, `height`, and any other statics. Birth
year and sex belong here too if calorie work is ever added, since BMR formulas need them.

**user_context** — goals, injuries, preferences, equipment, refusals with reasons, training
history, spacing needs ("my lower back wants 48 hours between heavy squats and deadlifts").

One **append-only** table:

| column | notes |
|---|---|
| id | |
| topic | free text — "goals", "lower back", "equipment" |
| content | prose |
| written_on | |

Rows are never updated or deleted. Changing or correcting a fact means writing a new row on
the same topic; the **current context is the latest row per topic** (`DISTINCT ON (topic)`),
and the full table read in order is the history. Retiring a topic means writing a final row
whose content says it no longer applies.

Rule for Claude, enforced in the logging doc: **before writing context, read the current
context and reuse the existing topic string.** This is what keeps "lower back" and "lumbar"
from becoming two live topics. Content is read as prose by an LLM, so an occasional duplicate
is cosmetic, not a wrong number — no arithmetic lives in this table.

`GET /user-context` returns all current entries together, never a filtered subset: a coach's
picture of a person is coherent, and rows read as a list lose that.

The previous drafts had a versioned markdown document, then a current-table plus a
`user_history` log. Both are gone — the first hid facts in prose, the second stored the same
prose twice.

**bodyweight** — `id`, `value`, `measured_at`, `source`. Its own table because it changes.
**Unique on `(measured_at, source)`** — a natural key, so a retried write bounces instead of
planting a phantom data point in the trend. `source` exists from day one so a smart scale or
watch feed doesn't need a migration — on Supabase, an edge function receiving a webhook writes
here directly when that day comes.

Anything else that gets measured over time gets its own named table when it actually exists.
Nothing computed is ever stored.

### Reference data

**muscles** — `id`, `name`

**exercises**

| column | notes |
|---|---|
| id | |
| name | canonical name |
| equipment | |
| pattern | descriptive only, nullable, nothing depends on it |
| stimulus_type | CHECK: strength / power / conditioning |
| notes | |

**exercise_aliases** — `id`, `exercise_id`, `alias`. Unique on alias. Without this, "sldl" and
"stiff leg deadlift" become two exercises and every progress query is quietly wrong. The API
resolves names and aliases to exercises server-side (§8), so this table is load-bearing.

**exercise_muscles** — `id`, `exercise_id`, `muscle_id`, `counts` (boolean), `fatigue`
(CHECK: none / some / lots). Unique on (exercise_id, muscle_id).

The starting catalogue is about 50 exercises, generated by Claude at setup rather than imported
from an open dataset. More get added over time through a dedicated endpoint, used deliberately
in conversation. The log page must never create an exercise.

### The plan

**blocks** — `id`, `name`, `goal`, `started_on`, `ended_on`

**mesocycles** — `id`, `block_id`, `name`, `intent` (prose, purpose not arithmetic),
`planned_weeks`, `sessions_per_week`, `started_on` (a Monday), `ended_on`, `request_id`
(nullable, unique — see idempotency in §8)

No `status` column. Only the row with `ended_on IS NULL` is active. An early `ended_on` means it
was cut short; why lives in the decision log. A **partial unique index** — unique on rows
`WHERE ended_on IS NULL` — makes "only one active mesocycle" a database guarantee instead of a
convention the LLM has to remember.

**mesocycle_exercises** — the fixed list.

| column | notes |
|---|---|
| id | |
| mesocycle_id | |
| exercise_id | |
| role | CHECK: main / accessory |
| priority | lower goes earlier in the week |
| rep_low, rep_high | nullable |
| notes | |

**mesocycle_weekly_exercise_sets** — planned working sets, one row per exercise per week.

| column | notes |
|---|---|
| id | |
| mesocycle_exercise_id | FK to mesocycle_exercises |
| week | |
| sets | |

**mesocycle_load_targets**

| column | notes |
|---|---|
| id | |
| mesocycle_exercise_id | FK to mesocycle_exercises |
| target_weight, target_reps | |
| baseline_weight, baseline_reps | where you were when the mesocycle started |
| by_week | nullable |

Both tables reference `mesocycle_exercises.id` instead of carrying `mesocycle_id` and
`exercise_id` separately. A weekly row or a load target can't exist for an exercise that isn't
in the plan, and role, priority and rep range are one join away. Consequence, since there are
no cascades: removing an exercise from the plan deletes these child rows first, then the
`mesocycle_exercises` row — all inside the revision transaction.

Baseline is stored because it isn't cleanly derivable — "what could I squat when this started"
depends on which session you pick and how you treat a bad day. Write it down once.

**mesocycle_decisions** — `id`, `mesocycle_id`, `made_on`, `what_changed`, `why`. Append only.

The name is settled, and there is no `block_decisions`: every decision in practice attaches to
a mesocycle — revisions, early endings, review outcomes (including "hold, change nothing").
A block-level pivot shows up as ending a mesocycle early, and that row's prose carries the
block-level why. One home means the LLM never has to choose where to write.

Specific tables rather than one generic `decisions` table, because a generic one becomes a junk
drawer and forces Claude to read everything to find what's relevant. Every "why" has a home:
plan changes go here, session reasoning goes in `sessions.rationale`, changes about the person
go in the user context table.

### The training record

**sessions**

| column | notes |
|---|---|
| id | |
| public_id | random text, used in the log page URL |
| mesocycle_id | |
| date | |
| type | default `lift` |
| rationale | why the session looks like this — write it every time |
| notes | |
| overall_feel | nullable |
| started_at, completed_at | |
| request_id | nullable, unique — see idempotency in §8 |

**sets**

| column | notes |
|---|---|
| id | |
| session_id | |
| exercise_id | |
| position | order within the session |
| kind | CHECK: warmup / working |
| target_weight, target_reps | filled in when the session is generated |
| weight, reps | filled in when performed; null means not done |
| effort | CHECK: easy / hard / failure |
| performed_at | gives rest times for free |
| notes | |

An additional `CHECK` enforces the effort rule at the source of truth: a working set with
`weight` not null must have `effort` not null. The page enforces it with chips; the constraint
catches every other path in, including chat logging.

**Create the set rows when the session is generated**, with targets filled in and actuals
empty. Logging fills them in rather than inserting. Three things come free: the log page just
renders rows, a skipped set is a row with targets and no actuals, and planned-versus-done needs
no extra bookkeeping. Unplanned sets are rows with no targets, created through the API (§8).

A skipped exercise or set stays in the table as its row with null actuals — **never delete a
planned row**. The row with empty actuals is the explicit record that the work was planned and
not done, and explicit rows are harder for an LLM to overlook than absent ones.

Once written, a target on a set row never changes, even if the plan is later revised. It has
stopped being a prediction and become the record of what was asked for that day. That is what
makes planned-versus-done answerable at all.

A **retro-logged session** (a workout done and forgotten) is a session with a past date whose
sets carry actuals and **null targets**. Don't invent targets after the fact: a target means
"what was asked before the work", a forgotten session had no ask, and fabricated targets would
always match what was done — quietly corrupting every planned-versus-delivered number.

### Indexes

`sets(session_id)`, `sets(exercise_id, performed_at)`, `sessions(date)`,
`sessions(public_id)`, `exercise_aliases(alias)`, the partial unique index on active
mesocycles, and the unique constraints backing idempotency (`sessions.request_id`,
`mesocycles.request_id`, `bodyweight(measured_at, source)`).

### Views

Two views, both computed at read time — a view stores nothing, so the
no-stored-calculations rule holds. They exist because these are the two queries with real
rules in them, and rules deserve one named home.

**weekly_volume** — working sets per muscle per week. Strength stimulus only, finished weeks
only, one row per muscle, never a total.

**weekly_exercise_sets_done** — delivered working sets per exercise per week. The direct
comparison partner of `mesocycle_weekly_exercise_sets`: reviewing a mesocycle is these two
side by side. Same rules — strength only, finished weeks only.

Other counting queries stay in endpoint code unless they grow rules of their own.

---

## 8. The API

Reviewed in full on 5 August 2026 against the six coaching jobs and the schema above. The
review found two structural gaps (no write path for the plan's child tables; no way to create
an unplanned set), a reliability hole (no retry safety), and several read problems. All fixed
below. Exact JSON field names get settled during implementation, guided by the rules here.

### API-wide rules

- **A read is named for what it contains, never for who calls it or why.** If renaming the
  caller would make the endpoint name wrong, the name was wrong.
- **Every fact is reachable on its own.** Composite reads exist because the client is an LLM
  and every round trip costs tokens and seconds — but a composite is a view over things that
  each have their own address. The moment something is only obtainable through the bundle,
  it's a mystery bag.
- **Errors are prompts.** The client is an LLM: the error body is the only teacher in the
  room. Every rejection states in plain English what was wrong and what a correct call looks
  like — "effort is required on a performed working set; send easy, hard, or failure". A good
  422 makes Claude fix its own call in the next turn.
- **One static bearer token** on every coach-API endpoint. Not user auth — a lock against bot
  scanners spraying POSTs at guessable Supabase function URLs. The skill knows it; one
  middleware line checks it. The log page namespace (`/s/:public_id`) is the exception: it is
  not part of the coach API — the page is server-rendered there, its form posts go to routes
  under the same path, and those handlers write to Postgres directly, in-process. The
  unguessable public_id is that namespace's auth. No token ever reaches the browser.
- **Idempotent writes.** `PATCH` endpoints are naturally safe to retry. The creating `POST`s
  (`/sessions`, `/mesocycles`, revisions) accept a client-generated `request_id`, stored
  unique; a retry with the same id returns the original result instead of acting twice.
  `bodyweight` dedupes on its natural key. The client is an LLM and a phone with flaky
  connectivity; retries must never duplicate.
- **`current`** is accepted anywhere a mesocycle id goes: `/mesocycles/current`,
  `/mesocycles/current/decisions`, and so on. Resolves to the row with `ended_on IS NULL`.
- **Exercises resolve by id, name, or alias**, server-side, through the unique alias index.
  The caller in conversation says "bench", not 17.

### Reads

- `GET /training-state` — the composite. Everything true about the training as of now.
  Contents listed below.
- `GET /mesocycles/:id` (and `/current`) — the plan, exactly: the mesocycle row, its exercise
  list with roles, priorities and rep ranges, the weekly planned sets, the load targets, and
  which week it is. Nothing from the training record — days-since-trained lives in
  `/training-state`, where history belongs.
- `GET /sessions?mesocycle=&limit=` — session rows only, no sets. Filterable by mesocycle for
  reviews.
- `GET /sessions/:id` — one session with all its sets, warmups included.
- `GET /weekly-volume?mesocycle=` — the `weekly_volume` view: rows of week × muscle. Defaults
  to the current mesocycle.
- `GET /weekly-exercise-sets?mesocycle=` — the `weekly_exercise_sets_done` view: rows of
  week × exercise. Defaults to the current mesocycle. Reviewing = this against the planned
  rows from `GET /mesocycles/:id`.
- `GET /exercises/:idOrName/history` — every working set for that lift over time. Accepts id,
  name, or alias.
- `GET /exercises` — the catalogue, with aliases and muscle mappings. Also feeds the log
  page's add-exercise select.
- `GET /user-context` — all current entries (latest row per topic), together.
  `?history=true` returns every row in order.
- `GET /mesocycles/:id/decisions` — the decision log for one mesocycle. `/current` works.

### Writes

- `POST /mesocycles` — **the complete plan in one call**: the mesocycle fields plus its
  exercise list, weekly set rows, and load targets, nested, in one transaction. A partial plan
  cannot exist. Same nested shape as revisions, so Claude learns it once. Takes `request_id`.
- `POST /mesocycles/:id/revisions` — the mid-mesocycle revision, one call, one transaction:
  removals, additions, changed weekly rows and load targets, and a **required** decision
  (`what_changed`, `why`). Rejected without the decision — the API mechanically enforces
  coaching job 6. All-or-nothing. Takes `request_id`.
- `PATCH /mesocycles/:id` — trivial single-field edits only (e.g. `ended_on`). Structural
  change goes through the revision endpoint.
- `POST /blocks`
- `POST /sessions` — two shapes, takes `request_id`. **Upcoming**: creates the session and its
  set rows with targets, for the log page. **Retro**: past date, sets with actuals and null
  targets, no log page involved.
- `POST /sessions/:id/sets` — creates an unplanned set row: actuals, null targets. Behind the
  log page's extra-row and add-exercise actions, and available to Claude when logging in chat.
- `PATCH /sets/:id` — one set, sent as it's entered. Flat, not nested under the session: a set
  id is unique on its own, position and id diverge as soon as an unplanned set is added, and
  patching a known id is idempotent, which matters because the log page resends after being
  offline.
- `PATCH /sessions/:id` — notes, how it felt, marking it complete. Finishing a workout is a
  field changing, not a separate action. Claude can complete a session this way too — the log
  page is the primary way to log, not the only one.
- `POST /exercises`
- `POST /user-context` — appends a row; topic string reused from current context (§7).
- `POST /bodyweight` — deduped on `(measured_at, source)`.

### Other

- `GET /docs/:name` — the skill's markdown.
- `/s/:public_id` — the log page namespace. Server-rendered HTML with the session data
  embedded; its own sub-routes receive the page's form posts and write to the database
  directly, without passing through the coach API. Tokenless; the public_id is the auth.

### What /training-state returns

Agreed content, nine things:

1. Today's date and which week of the mesocycle it is.
2. The mesocycle's intent.
3. Its fixed exercise list, with rep ranges, roles and priorities.
4. This week's planned sets per exercise.
5. This week so far: working sets done, and sessions done against sessions intended.
6. The last few *finished* weeks, same counts.
7. Days since each exercise in the mesocycle was last trained.
8. The last three to five sessions: date, working sets, rationale, notes, how it felt.
9. The current user context.

Working sets only in the recent-session history, and the top set per exercise rather than every
rep. Warmups stay in the database and stay reachable through `GET /sessions/:id`; they don't
ride along in the composite.

### Two things to get right in the counting queries

- **Only finished weeks go into weekly averages.** The current week is reported separately,
  never blended in. Weeks are Monday–Sunday, Europe/Rome (§5), so the boundary is unambiguous.
- Every set resolves to a known exercise. Nothing is created on the fly.

---

## 9. The log page

The primary interface for logging.

- Prefilled with the session: exercises, target weights, target reps, and last time's numbers,
  all visible **before** the set is done. Targets are immutable once the session exists.
- One row per set. Sends each set as it's entered, so closing the browser loses nothing.
- Effort chips on every working set. Required — and backed by the database CHECK (§7).
- Records the time of each set automatically.
- Extra rows for unplanned sets, via `POST /sessions/:id/sets`. A notes field per exercise.
- **Adding an exercise** not in the session: a select input reading from `GET /exercises`.
  The page never creates an exercise.
- **Skipping**: leave the rows empty. Empty planned rows stay in the database as the record of
  work planned and not done (§7).
- Offline: hold in local storage, send when back online. Resending is safe because
  `PATCH /sets/:id` is idempotent.
- No logic. It renders what the API sends and posts back what was typed.

The link is protected by an unguessable id and nothing else. The worst case is a stranger
editing a squat, and there is one user. The page is served and handled entirely inside the
`/s/:public_id` namespace: server-rendered with the session data embedded, form posts to
sub-routes of the same path, handlers writing to Postgres directly. The coach API's bearer
token never appears anywhere near the browser. Considered and rejected: serving the log UI as
a Claude artifact — the artifact sandbox blocks fetch to external domains (MCP is the only
hole through), artifacts can't use localStorage, and mid-workout state would die every time
the app reloads.

The page is the primary way to log, not the only one. Entering sets in chat is allowed —
retro-logging a forgotten workout is the obvious case — it's just not the expected day-to-day
flow, because in-chat panels can't reliably call your own server and mid-workout chat has
latency.

---

## 10. The skill

This is where the value is. The database records what happened; the documents are what make
Claude coach rather than log.

- **Entry file** — small. Fetches the training state, then whichever document fits the task.
  Written as instructions, not suggestions: "before deciding anything about the plan, fetch
  `/docs/programming`."
- `/docs/index` — one line per document saying when to read it.
- `/docs/session-generation` — how to write today's session, including how many sets of one
  exercise are useful in a single session, and how to keep each exercise's weekly sets stable
  so per-exercise progress stays readable.
- `/docs/programming` — when to add weight, how volume ramps, when to deload, how to build a
  mesocycle, how double progression works against `rep_low` and `rep_high`. **Progression lives
  here.**
- `/docs/evaluation` — how to review a mesocycle, per §5: planned rows against
  `/weekly-exercise-sets`, load targets against history.
- `/docs/charts`
- `/docs/logging` — includes the user-context topic-reuse rule (§7).
- `/docs/evidence/*`

### How to write these documents

Write them as decisions, not explanations. Not "research suggests 10–20 sets per muscle per
week" — that leaves room for nice-sounding prose. Instead:

> If a muscle is behind and getting fewer than 10 working sets a week, and the user is
> completing most sessions, add sets before changing exercises. If they're missing sessions,
> fix that first.

One line of reasoning, no literature review. The point is consistent decisions.

Worth stating in `/docs/programming`: the standard volume model is contested. Ramp gradually,
watch performance, back off when it stalls — not "ride it to your ceiling".

Note on caching: a skill refetches its documents per conversation — there is no cross-chat
cache. Accept the request cost; keep the documents lean instead.

---

## 11. Showing progress

The API returns series in one consistent shape. `/docs/charts` defines four or five standard
views: one exercise over time, weekly volume by muscle, planned sets against delivered,
how hard sessions have felt, bodyweight. "Show me my progress" should look the same every time.

---

## 12. Scope

**In:** setup, user context, blocks and mesocycles with both kinds of target, session
generation, the log page, logging, progress queries, mesocycle review, decisions, charts, the
uptime monitor, the bearer token.

Correct from the second workout. Not a throwaway first version.

**Out for now:** calories, running, watch data, body measurements, drop sets, user auth,
multi-user. Don't make them require a rewrite — `sessions.type` defaults to `lift`,
`bodyweight` has a `source` column, and nothing is hardcoded to the word "RIR".

---

## 13. Still open

Nothing. The design is closed.

Resolved since the last brief: the decisions table (`mesocycle_decisions`, one table, no
`block_decisions`), the API pass (§8, all findings folded in), the composite's name
(`/training-state`), hosting (Supabase), the shape of `user_context` (single append-only
table), the foreign keys (both plan child tables reference `mesocycle_exercises.id`), week
definition (Monday–Sunday, Europe/Rome, Monday-start mesocycles), the revision write
(transactional endpoint with required decision), retro-logging (null targets), and the log
page's add-exercise and skip behavior.

---

## 14. Build order

1. The schema in §7 — tables, checks, unique constraints, both views.
2. The uptime monitor and the bearer token middleware. Minutes of work; do them before
   forgetting.
3. Load the exercise catalogue and write the first user context.
4. Writes, including `POST /mesocycles` with the nested plan and the revision endpoint.
5. The counting queries, starting with `/training-state`.
6. The log page.
7. Entry file plus the session-generation and logging documents — enough to run one real
   workout end to end.
8. Everything else, once it's been used.

---

## 15. Implementation decisions

All decided on 5 August 2026. This section plus §7 and §8 is the handoff for Claude Code.

- **One edge function, one router.** The whole API is a single Supabase Edge Function with a
  Hono router. One warm isolate, one deploy, the token middleware written once. Many small
  functions would mean many separate cold starts.
- **postgres.js, plain SQL, no ORM.** Direct connection through the Supabase pooler in
  transaction mode — the revision and mesocycle-creation endpoints need real multi-statement
  transactions, which rules out going through PostgREST. No Drizzle: the queries that matter
  (views, `DISTINCT ON`, week logic) are raw SQL under any builder, and type safety across
  sixteen tables and one consumer isn't worth the extra layer to keep in sync.
- **Migrations are numbered SQL files** in the repo, Supabase CLI format, applied by the
  deploy workflow. That's the versioning story: schema history is git history.
- **One repo.** Migrations, the function, the skill docs, everything. One push moves it all
  in lockstep. A GitHub Action on push applies migrations and deploys the function.
- **Skill docs are bundled into the function** and served by `GET /docs/:name`. A git push is
  the update, via the deploy Action. No fetching from raw.githubusercontent at request time —
  no external dependency in the conversation path.
- **The log page is server-rendered with vanilla JS.** No framework, no build step. The
  client JS does three things: effort chips, posting each set as entered, and the offline
  retry queue in localStorage (~30 lines). Considered and rejected: htmx (no offline story,
  and once the queue exists it buys nothing on a three-interaction page) and local-first sync
  frameworks like Zero (requires deploying its own sync server — an order of magnitude more
  machinery than a retry queue).
- **Environments: local dev, one hosted project.** The Supabase CLI runs the full stack
  locally in Docker; the hosted project is production only. A second hosted project would
  burn the free tier's 2-project limit for nothing.
- **Timezone is always explicit.** Every week-boundary query says `AT TIME ZONE
  'Europe/Rome'`. Never rely on the server clock; servers run UTC and one implicit conversion
  puts Sunday-night sets in the wrong week.
- **`request_id` values are client-generated** (Claude makes a UUID per creating call); the
  skill's logging doc says so.
