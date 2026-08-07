# Hypertrophy

The methodology for growing muscle. `tasks/programming` builds the plan, `tasks/session-generation`
writes the day, `tasks/evaluation` judges the result — all three apply what is here. These are
decisions, not laws of nature: change them by changing this document.

Every number below is a population average with wide individual spread. They set the
starting point. This person's own record overrides them, always — it is the one piece of
evidence no study has.

## What actually drives growth

Three things, in order of how much they matter:

1. **Enough hard sets per muscle per week.** The dose.
2. **Sets taken close enough to failure.** The quality of each unit of dose.
3. **Load or reps rising over months.** Not a driver — the evidence that the first two
   are still working as the person adapts.

Nearly everything else — exercise order, rest length, tempo, split design, the exact rep
range — is second-order. When something is not working, look at 1 and 2 before touching
anything else. The characteristic failure of an articulate coach is fiddling with the
second-order variables, because they are the easiest ones to have an opinion about.

Second-order still gets a default, so it never becomes a decision: rest 2–3 minutes
on compounds and 1–2 on isolation — long enough that the next set is limited by the
muscle rather than by breathing — and don't measure it. Cutting rests short quietly
shrinks what each set buys; it is the one second-order variable cheap enough to just
get right.

## Volume: a curve with a rising price

Do not think of weekly volume as a target number to reach. Think of it as a curve that
keeps rising and keeps getting more expensive:

- Around 4 weekly sets for a muscle already produces detectable growth.
- Each further increment of growth costs more sets than the last: roughly 6 extra weekly
  sets to buy one increment in the 5–10 range, ~8.5 in the 11–18 range, ~10.75 in the
  19–29 range.
- No ceiling has been found where more stops working. But data above ~25 sets is thin and
  the uncertainty is wide, so claims about the top of the curve are guesses.

The practical consequence: **there is no optimum to find.** There is a dose that fits this
person's recovery, schedule and willingness, and above roughly 4 sets almost any honest
dose grows muscle. More is mildly better and steeply more expensive. So choose volume by
asking what they can deliver every week for two months, not by asking what the maximum is.

Start a priority muscle around 8–12 weekly sets and a secondary muscle lower. Go higher
only when the sets are actually being delivered, effort is honest, and progress has
stalled for a reason volume could plausibly explain.

**The counting scale matches the research.** The research figures above count in
fractional sets: a directly trained muscle earns 1.0 per set, an indirectly trained one
0.5. The database speaks the same language — each set adds its `volume_factor` to every
muscle it trains — so `GET /weekly-volume` returns numbers on the same scale as the
dose-response landmarks above, no conversion needed. The numbers are fractional
(glutes 13.5 is a normal reading), and the classification behind them lives in the
catalogue — `reference/exercises` holds the rule.

## Effort: what decides whether a set counts

Hypertrophy improves as sets are taken closer to failure. Strength barely cares. This is
the single largest difference between programming for size and programming for strength,
and it inverts how load gets chosen.

**Choose the effort first, then find the weight that produces it.** The prescription is "a
hard set of 8", not "80 kg for 8". The weight is whatever makes 8 reps hard today. This is
why a target that was right last week can be wrong this week, and why repeating last
session's numbers is a sane default but never the aim.

The three effort chips mean:

- `easy` — four or more reps left. The set was too light to buy much. This is a
  programming error, not a fact about the person.
- `hard` — roughly 1–3 reps left. Where the large majority of hypertrophy sets belong.
- `failure` — nothing left, or the last rep broke down. Effective, but costly in fatigue,
  and it degrades every set that follows it. Occasionally is fine. Every set of every
  session is a fatigue problem that will surface later as a stall.

Trust these reports unevenly. People judge proximity to failure well when they are close
to it and badly when they are far from it. So `hard` and `failure` are reasonably
reliable, and `easy` is reliable in the direction that matters — the weight was too light
— even if the person cannot say by how much.

**`easy` everywhere with flat numbers is not a stalled programme.** It is under-effort.
Raise the loads before concluding anything about the plan, and never add sets to
compensate for sets that were not hard.

## Frequency: mostly free

At matched weekly volume, training a muscle more often has a negligible effect on growth.
Treat this as liberating rather than limiting: the weekly dose is what matters and how it
is spread across days is largely the person's to arrange around their life.

- Never program more sessions than the person said they can do. Frequency buys almost
  nothing that the same sets arranged differently do not.
- A missed day is a volume question, not a frequency question. Ask whether the week's sets
  still land, not whether the split is broken.
- Do not pursue "every muscle three times a week" as a goal in itself.

One within-session limit is worth knowing: returns fall off past roughly ten hard sets for
a single muscle in one session. That is far more than a normal session holds, so it rarely
binds. The reason to keep one exercise to 3–5 sets in a session is different and more
practical — past five, the later sets are degraded by fatigue from the earlier ones, and
per-exercise progress becomes hard to read.

## Load and reps

For growth a wide span of loads works provided effort is matched — roughly 5 to 30 reps.
Heavy loads are meaningfully better for strength, not for size. So the rep range for each
exercise is a practical choice, not a physiological one:

- **Can the set be pushed near failure safely?** A heavy free-weight squat to 1 RIR alone
  at home is a different proposition from a leg press. Where failure is risky, use lighter
  loads and higher reps so the last reps are genuinely reachable.
- **Joint comfort.** If heavy loading aggravates something, higher reps deliver the same
  growth stimulus with less of the problem.
- **Readability.** Very high rep sets are noisy — a small load change swings reps a lot.

The usual outcome is heavier compounds at 5–10, machine and cable work at 8–15, isolation
at 10–20. Write the intention in that exercise's `notes`.

**Double progression is the default mechanism.** Hold the weight and add reps week to
week; when every working set reaches the top of the range, add the smallest useful jump
(2.5 kg on upper body, 5 kg on lower) and drop back to the bottom. Use it because it keeps
effort inside the right band without ever needing a maximum test, and because it makes
progress readable one exercise at a time. State it in the mesocycle's `intent` so later
conversations apply it the same way.

Keep clear about what progression is for. Rising numbers are not the stimulus — hard sets
are. Progression is the readout confirming the hard sets are still hard enough as the
person gets stronger. That distinction decides how to read numbers that stop rising for
reasons which have nothing to do with the plan.

And the readout only works if the rep holds still. A rep counts against an
exercise's history only when it is performed to the same standard as the reps it is
being compared with — same depth, same control, no help from bounce or momentum.
Range quietly shrinking as the load climbs is the commonest way a solo lifter
manufactures progress that never happened, and nothing downstream can detect it in
the numbers. When a set only moved because the standard slipped, it did not move:
say so, and log it at the honest standard.

## Energy availability changes what everything means

Muscle is built out of food. Before programming for growth, establish whether the person
is eating to grow, eating to maintain, or in a deficit. If they have not said, ask. It is
not optional context.

It changes little about the training and almost everything about the interpretation:

- **Eating to grow.** Load and reps should climb. Weeks of flat performance with sets
  delivered is a real signal about the plan.
- **Maintenance or deficit.** Growth is slow or absent, and holding performance is a
  success rather than a stall. Do not diagnose a failing programme, do not add volume in
  response, and say plainly that the binding constraint is food, not training.

Record what they say in user context so it outlives the conversation.

## Exercise selection

- **Choose lifts where the target muscle is what actually ends the set.** This is the
  commonest reason a muscle fails to grow while its volume looks fine on paper. If someone's
  quads give out before their glutes in every squat pattern, the glutes are not being
  trained, however many sets are logged against them.
- **Full range of motion is the default.** Training at long muscle lengths has a modest
  edge in some evidence and none in other; it is nowhere near settled enough to
  reorganise a programme around. Do not present it as established, and do not shorten
  range in pursuit of it.
- **Stability beats novelty.** Progress is read per exercise, so a swap throws that
  reading away. The bar for swapping mid-mesocycle is pain, unavailability, or a lift that
  keeps being skipped — never boredom and never a better idea.
- **Pick lifts the person will actually do.** A disliked exercise is an exercise that gets
  skipped, and a skipped exercise delivers nothing. This outranks theoretical superiority
  every time.
- **Two or three exercises per muscle is plenty.** More fragments the volume and makes
  progress unreadable.

## Volume across a mesocycle: usually hold, don't ramp

Ramping weekly sets upward through a mesocycle is common practice with weak support: in
trained lifters, progressively adding sets has not outperformed holding a constant,
adequate volume — though it does reliably make the training feel harder.

So the default is a flat, sustainable weekly volume for the length of the mesocycle. Ramp
only as a deliberate experiment — the work is being delivered, effort is honest, progress
has stalled — and treat the ramp as a question being asked rather than a schedule being
followed. Never ride volume upward because a model says higher is better; that is exactly
the mistake the shape of the curve warns about.

## Deloads: reactive, not scheduled

Scheduled deloads are traditional and poorly supported. The clearest direct test placed a
one-week deload in the middle of a nine-week programme and found no hypertrophy benefit
and worse strength gains than training straight through.

Deload when there is a reason:

- performance falling across several sessions while the sets are being delivered
- joints or connective tissue complaining
- sleep, stress or life making honest hard sets unrealistic
- the person has lost the appetite for training

What it looks like: cut the sets to roughly half, keep the loads and the effort of the
sets that remain, keep training. Complete rest is worse — strength goes first. A deload is
one week. If a second seems necessary, the question is no longer fatigue; it is whether
the programme fits this person's life.

## What "working" looks like

Growth cannot be seen week to week, and nothing available here measures muscle size. The
proxies, in order of usefulness:

- reps rising at a fixed weight, or weight rising at fixed reps, on the same exercise
  across 3–6 weeks
- bodyweight drifting up slowly while eating to grow
- the same work reported `hard` that used to be reported `failure`

What normal looks like, so "flat" has a baseline: early in a mesocycle, double
progression on an exercise typically buys about one rep per week somewhere in its
sets, slowing as the weeks accumulate — and slower again, or simply holding, at
maintenance or in a deficit. Meaningfully faster than that usually means the
opening loads were light, not that growth is rapid.

Judge over weeks. One session is noise; two bad weeks are data. `tasks/evaluation` holds the
procedure for turning this into a decision.

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

- Volume dose–response and the efficiency tiers, and frequency's negligible independent
  effect on hypertrophy — Pelland et al., *Sports Medicine*, 2025 (meta-regression, 67
  studies).
- Per-session ceiling around 11 fractional sets — Remmert et al., SportRxiv, 2025.
- Proximity to failure, and its asymmetry between size and strength — Robinson et al.,
  *Sports Medicine*, 2024.
- Ramped versus constant weekly sets in trained lifters — Enes et al., *MSSE*, 2024.
- Mid-programme deload — Coleman et al., *PeerJ*, 2024.
- Long muscle lengths, contested — Wolf et al., *PeerJ*, 2025 (equivalence with full ROM)
  against a 2025 meta-analysis favouring long lengths.
