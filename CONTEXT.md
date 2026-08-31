# Personal trainer

Marco's strength-training and nutrition coach: a database of facts, a corpus of
coaching documents, and an LLM that reads both. The database stores what
happened; the documents hold the judgment; nothing in the code decides anything
about training or eating.

## The plan

**Block**: A span of training with a single goal, containing one or more
mesocycles.

**Mesocycle**: A plan: which exercises, at what dose, for how many whole weeks,
starting on a Monday. Its `intent` is prose — the purpose, never arithmetic.
_Avoid_: Programme, cycle, phase

**Track**: A line of training with its own goal, week number, dose and method
document — hypertrophy, strength, speed, endurance. More than one can run at
once, and a shortfall on one is never repaid by another. _Avoid_: Discipline,
modality

**Dose**: The weekly amount of an exercise a mesocycle prescribes. The current
truth, not a trajectory; its history is kept separately so past weeks stay
judged against the dose in force at the time. _Avoid_: Target volume,
prescription

**Redose**: Changing an exercise's dose mid-mesocycle. Takes effect from the day
it was decided and never rewrites how earlier weeks were judged.

**Decision**: The recorded reason a plan changed. Every plan change carries one.

## The training record

**Session**: One training occasion — planned or performed. Always a _training_
session in this codebase; never a login, a web visit, or a conversation.
_Avoid_: Workout, training day

**Set**: One set of one exercise within a session, holding targets and actuals
side by side. Targets with null actuals are the record of work planned and not
done; actuals with null targets are a set logged after the fact. Neither is
deleted.

**Effort**: How hard a set was: `easy`, `hard`, or `failure`. Not a numeric
scale. _Avoid_: RIR, RPE, intensity

## Eating

**Food**: A catalogue entry with per-100g macros and an honest `source`. A
different brand, recipe or preparation is a _different food_, never an edit —
editing a food rewrites every entry ever logged against it, so it is only ever
done to fix a mistake.

**Meal**: A named, reusable set of foods and quantities. Created when a
combination becomes routine, not for a one-off variation.

**Intake entry**: One record of something eaten, on a day. May itemise foods or
be **ad-hoc** — a kcal figure with no macros, which makes that day's protein
total a floor rather than a total.

**Target**: The energy and protein a goal phase is aiming at: a cut, a bulk, or
maintenance.

**Expenditure**: An _estimate_ of energy burned, carrying a band and a status. A
difference inside the band is noise by construction, and a calorie figure the
system did not produce is never presented as its answer.

**Day flag**: A marker that a day is unusable — `incomplete` excludes it from
the expenditure window.

## Facts and memory

**User context**: Append-only lasting facts about Marco, one row per topic.
Correcting a fact means writing a new row, never updating the old one. This is
the system's memory; past conversations are not.

**Alias**: Another name for an existing exercise, food or meal. The alternative
to creating a synonym, which would split one thing's history in two.

## The app

**Conversation**: One ephemeral exchange with the coach. It is never named,
listed, or reopened: opening the app starts a new one, closing it ends it.
Transcripts are kept for inspection, but nothing in the product reaches back for
them. _Avoid_: Chat, thread, session

**Coach API**: The Supabase service holding the database and the coaching
documents. The only path to the data — every client reaches Postgres through it,
never around it.

**Agent backend**: The service that runs the LLM loop and holds the model
credentials. A client of the coach API like any other. _Avoid_: Server, backend
(unqualified)

**Coaching documents**: The prose that holds the coaching method and every
procedure — task, reference and method documents. They are the product, not
documentation of it: what a document says overrides the model's general
knowledge. _Avoid_: Docs, prompts, the skill
