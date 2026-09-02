# Planning — API reference

Blocks, mesocycles, decisions: payload shapes and schema rules. The procedure
and the judgment live in `tasks/programming`.

A mesocycle belongs to a **track** — the line of training it is: `hypertrophy`,
`strength`, `speed`, `endurance`. One mesocycle can be active per track, so a
hypertrophy plan and a speed plan run side by side. The track also names the
method document to read: `method/<track>`.

Rehab is not a track. It is a `role` an exercise plays inside a plan, so shoulder
rehab lives in the hypertrophy mesocycle, and two rehab progressions are two
rehab-role exercises.

Two kinds of number, kept apart. The **weekly dose** per exercise is structured,
because the server computes behind-and-ahead from it at every session. Everything
else — load goals, the progression mechanism, deload rules, rep intentions, the
falsification line — stays prose in `intent`, and no table restates it.

## Naming a mesocycle

`current` works while exactly one plan is active. With more than one it is refused
and the error names the active tracks; say `current:<track>` instead
(`current:speed`). A numeric id always works.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /blocks` | All blocks. |
| `GET /mesocycles/:id` | The plan: track, intent, exercise list with roles, priorities, doses and notes. |
| `GET /mesocycles/:id/decisions` | The decision log for that mesocycle. |

## Blocks

```json
POST /blocks
{ "name": "...", "goal": "...", "started_on": "YYYY-MM-DD", "ended_on": "<optional>",
  "request_id": "<fresh uuid>" }
```

A block groups mesocycles that share a goal over time. It carries no track of its
own — it belongs to whichever track its mesocycles are on, so a speed block and a
hypertrophy block coexist without either knowing about the other.

## Creating a mesocycle

```json
POST /mesocycles
{
  "request_id": "<fresh uuid>",
  "block_id": 1,
  "name": "Hypertrophy 1",
  "track": "hypertrophy",
  "intent": "<the plan's judgment — contents specified in tasks/programming>",
  "planned_weeks": 5,
  "sessions_per_week": 3,
  "started_on": "2026-08-10",
  "exercises": [
    {
      "exercise": "squat",
      "role": "main",
      "priority": 1,
      "weekly_dose": 9,
      "weekly_dose_unit": "sets",
      "notes": "per-exercise prose — rep intention, cues, constraints"
    }
  ]
}
```

- Only one mesocycle can be active **per track**. End that track's plan first or
  the create is rejected; plans on other tracks are not in the way.
- `started_on` must be a Monday; mesocycles run whole weeks, Monday–Sunday. Each
  plan is numbered from its own Monday, so "week 3" always needs its track.
- `sessions_per_week` is an input to session generation, not a weekly schedule.
  It is per plan, and the numbers across plans do not add up — one session can
  serve two.

## Changing a plan

One call, all-or-nothing, and never without `what_changed` and `why`. It can
change the exercise list, change a dose, replace the intent, end the plan, any
combination — or none of them:

```json
POST /mesocycles/current:speed/decisions
{
  "request_id": "<fresh uuid>",
  "what_changed": "...",
  "why": "...",
  "remove": ["back squat"],
  "add": [ { "...": "same shape as a creation entry" } ],
  "redose": [ { "exercise": "sprint", "weekly_dose": 0.32, "weekly_dose_unit": "km" } ],
  "intent": "<optional: the full replacement intent>",
  "ended_on": "<optional: YYYY-MM-DD>"
}
```

**Send no change fields and it is still a decision** — a review outcome of
"hold", a declared light week, a local back-off. Same call, same log. There is
one door onto a plan's history and everything that touches the plan goes
through it.

`redose` changes the weekly dose of an exercise already in the plan; one that
isn't in it is refused — add it instead. A dose change is a plan change like any
other, so there is no path to one without a reason.

`intent`, when present, replaces the whole text — never a fragment. The replaced
text is recorded on the decision row (`prior_intent` in
`GET /mesocycles/:id/decisions`), so history is never lost. Changing the intent
any other way is refused — it is the plan, and plans change only with a reason.

`ended_on` ends the plan and frees that track for the next one. It is a plan
change like any other, so it carries its reason in the same call: `PATCH` will
refuse it. `PATCH /mesocycles/:id` renames a plan and does nothing else.

## Field values

- `track` (mesocycle) — `hypertrophy` | `strength` | `speed` | `endurance`.
- `role` (mesocycle exercise) — `main` | `accessory` | `rehab`. `rehab` marks work
  that is in the plan to fix something rather than to drive the plan's adaptation:
  it carries a dose like anything else, but its progression comes from the rehab
  guidance rather than from the track's method document.
- `priority` (mesocycle exercise) — integer ≥ 1, no upper bound; low numbers
  deserve the freshest slots in a session.
- `weekly_dose` / `weekly_dose_unit` — how much of this exercise the plan asks for
  each week. Units: `sets` | `minutes` | `km`. Flat, not a per-week ramp: it is the
  current truth, and changing it is a decision. Must be greater than zero — an
  exercise that should not be trained this week either leaves the plan or is backed
  off by a decision saying for how long.
- Which units are legal depends on how the exercise is measured
  (`reference/exercises`): `sets` always, `km` only where distance is recorded,
  `minutes` only where time is. A `km` dose on a barbell squat is rejected, because
  nothing delivered could ever count towards it.
