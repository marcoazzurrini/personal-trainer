# Hypertrophy

The methodology for growing muscle. `tasks/programming` builds the plan, `tasks/session-generation`
writes the day, `tasks/evaluation` judges the result — all three apply what is here. These are
decisions, not laws of nature: change them by changing this document.

Every number below is a population average with wide individual spread. They set the starting
point; this person's own record overrides them, always — it is the one piece of evidence no
study has.

## Defaults at a glance

The numbers, so they never have to be re-decided. The sections below hold the judgment for
deviating.

| Variable                    | Default                                                       |
| --------------------------- | ------------------------------------------------------------- |
| Weekly sets per muscle      | 8–12 for a priority muscle, lower for secondary (fractional)  |
| Effort per working set      | `hard` (1–3 RIR); `failure` occasionally, never as the norm   |
| Rep ranges                  | Compounds 5–10 · machines/cables 8–15 · isolation 10–20       |
| Rest                        | 2–3 min compounds, 1–2 min isolation; don't measure it        |
| Sets per exercise/session   | 3–5                                                           |
| Exercises per muscle        | 2–3, non-redundant                                            |
| Progression                 | Double progression; +2.5 kg upper / +5 kg lower at range top  |
| Volume across a mesocycle   | Flat                                                          |
| Deload                      | Reactive only: one week, half the sets, same loads and effort |
| Protein floor               | ~1.6 g/kg/day                                                 |

## What actually drives growth

Three things, in order of how much they matter:

1. **Enough hard sets per muscle per week.** The dose.
2. **Sets taken close enough to failure.** The quality of each unit of dose.
3. **Load or reps rising over months.** Not a driver — the readout confirming 1 and 2 still
   work as the person adapts.

Nearly everything else — exercise order, rest length, tempo, split design, the exact rep
range — is second-order. When something is not working, look at 1 and 2 before touching
anything else. The characteristic failure of an articulate coach is fiddling with the
second-order variables, because they are the easiest ones to have an opinion about.

## Volume: a curve with a rising price

Not a target number — a curve that keeps rising and keeps getting more expensive. Around 4
weekly sets already produces detectable growth; each further increment costs more sets than
the last (roughly 6 extra weekly sets per increment in the 5–10 range, ~8.5 in 11–18, ~10.75
in 19–29 — treat the tiers as shape, not precision). No ceiling has been found, but data
above ~25 sets is thin and claims about the top of the curve are guesses.

The practical consequence: **there is no optimum to find.** Above roughly 4 sets almost any
honest dose grows muscle; more is mildly better and steeply more expensive. Choose volume by
what the person can deliver every week for two months. Go higher only when sets are actually
delivered, effort is honest, and progress has stalled for a reason volume could plausibly
explain.

**The counting scale matches the research.** These figures count fractional sets: 1.0 for a
directly trained muscle, 0.5 indirect. `GET /weekly-volume` returns the same scale (glutes
13.5 is a normal reading); the classification lives in the catalogue — `reference/exercises`
holds the rule.

## Effort: what decides whether a set counts

Hypertrophy improves as sets approach failure; strength barely cares. This is the single
largest difference between programming for size and for strength, and it inverts how load is
chosen: **choose the effort first, then find the weight that produces it.** The prescription
is "a hard set of 8", not "80 kg for 8" — which is why repeating last session's numbers is a
sane default but never the aim.

The three effort chips:

- `easy` — 4+ reps left. Too light to buy much. A programming error, not a fact about the person.
- `hard` — roughly 1–3 reps left. Where the large majority of hypertrophy sets belong.
- `failure` — nothing left. Effective but costly: it degrades every set that follows.
  Occasionally fine; every set of every session is a fatigue problem that surfaces as a stall.

Trust the reports unevenly: people judge proximity to failure well when close to it, badly
when far. `hard` and `failure` are reasonably reliable; `easy` is reliable in the direction
that matters. **`easy` everywhere with flat numbers is under-effort, not a stalled
programme** — raise loads before concluding anything, and never add sets to compensate for
sets that were not hard.

## Frequency: mostly free

At matched weekly volume, frequency has a negligible effect on growth. Treat this as
liberating: the weekly dose matters, and how it spreads across days is the person's to
arrange around their life. Never program more sessions than they said they can do; a missed
day is a volume question (do the week's sets still land?), not a frequency question. Returns
fall off past ~10 hard sets for one muscle in one session — far more than a normal session
holds. Keep one exercise to 3–5 sets for a different reason: past five, later sets are
degraded and per-exercise progress becomes hard to read.

## Load, reps, progression

For growth, roughly 5–30 reps all works when effort is matched; heavy loads matter for
strength, not size. So each exercise's range is a practical choice: can the set be pushed
near failure safely (a solo heavy squat at 1 RIR is not a leg press), does heavy loading
aggravate a joint, and is the set readable (very high reps are noisy). Write the intention
in the exercise's `notes`.

Double progression is the mechanism: hold the weight, add reps; when every working set hits
the top of the range, add the smallest jump and drop to the bottom. It keeps effort in the
right band without maximum tests and makes progress readable per exercise. State it in the
mesocycle's `intent`.

The readout only works if the rep holds still: same depth, same control, no bounce. Range
quietly shrinking as load climbs is the commonest way a solo lifter manufactures progress
that never happened, and nothing downstream detects it. When a set only moved because the
standard slipped, it did not move — say so, and log the honest standard.

## Context that changes what everything means

Muscle is built out of food and recovery. This document owns nutrition and lifestyle only as
far as they change how training data is read; targets, tracking and planning are out of
scope (a future `method/nutrition` will own them).

- **Energy state.** Establish whether the person is eating to grow, maintaining, or in a
  deficit — if unsaid, ask; it is not optional. Eating to grow: flat weeks with sets
  delivered are a real signal about the plan. Maintenance or deficit: holding performance is
  success, not a stall — do not diagnose the programme, do not add volume, say plainly the
  binding constraint is food. Record it in user context.
- **Protein floor.** Below ~1.6 g/kg/day, food is the constraint before the programme is.
  Ask once, record it.
- **Creatine** is the one supplement with robust evidence (~+1 kg lean mass over training
  alone, ~0.3 g/kg/day). Mention once when relevant; never push.
- **Sleep.** With chronically short sleep, read stalls as a recovery problem before a
  programming problem — same logic as the deficit.
- **Cardio.** Recreational amounts do not meaningfully blunt hypertrophy. Treat it as a
  schedule and recovery input, not a threat; do not "fix" a programme for an interference
  effect that is not there.

## Exercise selection

- **Choose lifts where the target muscle is what ends the set.** The commonest reason a
  muscle fails to grow while its volume looks fine on paper. (Coaching judgment —
  mechanically sensible, not directly trial-tested.)
- **Full range of motion is the default.** Long-length training has a modest edge in some
  evidence and none in other; not settled enough to reorganise a programme around.
- **2–3 exercises per muscle, non-redundant.** Systematic variation across angles and
  resistance profiles aids regional growth; excessive, random variation compromises it. More
  exercises fragments volume and makes progress unreadable.
- **Stability beats novelty.** Progress is read per exercise; a swap throws the reading
  away. The bar for swapping mid-mesocycle is pain, unavailability, or a lift that keeps
  being skipped — never boredom, never a better idea.
- **Pick lifts the person will actually do.** A disliked exercise gets skipped and delivers
  nothing. This outranks theoretical superiority every time.

## Volume across a mesocycle: hold by default

Default to a flat, sustainable weekly volume. The direct trials on adding sets through a
mesocycle in trained lifters show clear extra strength gains from ramping, and for
hypertrophy no significant difference — with a possible small dose–response trend at higher
volumes. So ramping is an option, not an error: hold because sustainability and readability
win, not because ramping fails. Ramp as a deliberate experiment — sets delivered, effort
honest, progress stalled — and treat it as a question being asked. Never ride volume upward
because a model says higher is better; that is the mistake the curve's shape warns about.

## Deloads: reactive, not scheduled

Scheduled deloads are poorly supported: the clearest test placed one mid-programme and found
no hypertrophy benefit and worse strength than training straight through. Deload when there
is a reason — performance falling across several sessions with sets delivered, joints
complaining, life making honest hard sets unrealistic, appetite for training gone. One week,
roughly half the sets, keep loads and effort, keep training (complete rest is worse). If a
second week seems necessary, the question is no longer fatigue but whether the programme
fits the person's life.

## What "working" looks like

Growth is invisible week to week and nothing here measures muscle size. Proxies, in order:
reps rising at fixed weight (or weight at fixed reps) on the same exercise across 3–6 weeks;
bodyweight drifting up slowly while eating to grow; the same work reported `hard` that used
to be `failure`. Normal early in a mesocycle is about one rep per week somewhere in an
exercise's sets, slowing as weeks accumulate — slower or flat at maintenance or in a
deficit. Meaningfully faster usually means the opening loads were light. One session is
noise; two bad weeks are data. `tasks/evaluation` holds the procedure.

## Failure modes

The mistakes a competent-sounding coach makes most often. Check against them before
proposing any change:

- **Adding volume when the answer was effort.** Sets logged `easy` do not need company,
  they need more weight.
- **Changing a plan that was never run.** Sets missed means untested, not failed.
- **Diagnosing a stall that is a deficit.** Read energy availability first.
- **Swapping exercises out of restlessness.** It destroys the only progression record
  there is.
- **Programming for a person who does not exist.** More sessions, more lifts, more
  discipline than they said they have. The excellent programme they abandon loses to the
  modest one they run.
- **Treating these numbers as more precise than they are.** They are wide, averaged, and
  mostly compatible with one another. This person's record is better evidence than any of
  them.

## Where this comes from

Kept short so the claims can be re-checked when the evidence moves:

- Volume dose–response, fractional counting, and frequency's negligible independent effect
  on hypertrophy — Pelland et al., *Sports Medicine*, 2025 (meta-regression, 67 studies).
- Per-session ceiling around 11 fractional sets — Remmert et al., SportRxiv, 2025 (preprint).
- Proximity to failure, and its asymmetry between size and strength — Robinson et al.,
  *Sports Medicine*, 2024 (exploratory meta-regression; estimated RIR).
- Ramped versus constant weekly sets in trained lifters — Enes et al., *MSSE*, 2024: clear
  extra strength from ramping, hypertrophy differences non-significant with a possible
  small trend; the 2025 female follow-up (*J Sports Sci*) found greater VL-CSA with
  progression.
- Mid-programme deload — Coleman et al., *PeerJ*, 2024.
- Long muscle lengths, contested — Wolf et al., *PeerJ*, 2025 (equivalence with full ROM)
  against a 2025 meta-analysis favouring long lengths.
- Protein breakpoint ~1.6 g/kg/day — Morton et al., *BJSM*, 2018 (meta-regression, 49 RCTs).
- Creatine ~+1 kg lean mass — Desai et al., *JSCR*, 2024 (meta-analysis).
- Systematic versus random exercise variation — Kassiano et al., *JSCR*, 2022 (systematic
  review).
