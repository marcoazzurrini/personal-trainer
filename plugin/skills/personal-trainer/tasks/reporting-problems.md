# Reporting a problem

Neither these documents nor the API are fixed. When something in the system is
in the way — an unexplained failure, a number that came back wrong, an error message
that sent you somewhere useless, a procedure that produces the same friction
every time — file an issue. Marco reads it and the change is written from the
repository, where the code and its tests can actually be seen.

You do not edit anything here. You report. The documents are files beside this
skill and you can open them, but what you can see is an installed copy: an edit
to it never reaches the repository and is gone at the next update. The split is
deliberate anyway: you have the conversations and none of the repository, so
the thing only you can produce is evidence — what you called, what came back,
how often, what it cost the session. The diagnosis and the fix belong where the
code is visible.

## Urgent care outranks reporting

For potentially urgent systemic symptoms, stop the whole workout and give the
urgent-care direction in `SKILL.md` before token acquisition, state reads, logging,
issue lookup or filing. Do not train another area or resume reporting while urgent
help is needed. Continue administration only after urgent care is addressed.

## Public evidence boundary

Reports and comments go to a **public repository**. Sanitize **every field**, including
title, problem, evidence, suggestion and comment notes, before sending anything.
Remove authorization headers, tokens, cookies and other credentials; never publish
credentials even with consent. Preserve method, path, relevant field names, status,
and reproduction steps, but replace personal identifiers and health details with
synthetic values wherever possible. Mark substitutions as synthetic, not observations.
Use `[REDACTED]` for an entire removed value, not a token with a few characters hidden.
For example: `Authorization: Bearer [REDACTED]`, `Cookie: [REDACTED]`, and a synthetic
food/quantity reproducing the same refusal. Do not copy raw curl output or headers.

If sensitive health or personal evidence cannot be removed without losing the problem,
ask Marco's explicit consent for the exact details and public destination **before**
exporting those details. A safe synthetic report can still be filed immediately;
ordinary sanitized reporting needs no blanket confirmation. If consent is absent,
withhold the sensitive portion and say what evidence is unavailable. The API's narrow
bearer/cookie guard is defense in depth, not a guarantee that all secrets are detected.

## Expected refusals are recovery, not bugs

- **Unknown reference:** look up the existing food, meal or exercise, check aliases,
  then create only something genuinely new. For an unknown food use
  `tasks/nutrition-logging`; never invent macros or duplicate a synonym.
- **Expired authentication (401):** outside urgent care, refresh with
  `get_api_token` once and retry the same operation with the same `request_id`.
  A second refusal stops the authentication loop; explain the unresolved failure.
- **Actionable validation (422):** read the message and reference document, then
  correct the fields or units for the same intended operation. Do not file the
  correct refusal as a bug. If the recommended correction still fails despite
  following the contract, that failed recovery is reportable.

A status alone is not a diagnosis of a bug. An unexplained 500, an impossible
successful result, or recovery instructions that do not work is reportable.
An absent supported feature is an improvement, not proof of a broken call.

## A bug: file it immediately, then carry on

The system did something wrong:

- A call failed without an explained recovery, or returned something impossible.
- An error message told you to do something that did not work.


**Outside the urgent-care exception, file it the moment you see it, even in the middle of a task.** Do not wait for
the conversation to end and do not ask first for a safe sanitized report. The public evidence boundary above always applies. Then say in one line that you filed
it, give Marco the URL, and go straight back to what he was doing.

The reason for the interruption is that you are the only thing that saw it. A bug
noticed and not filed is gone: the next conversation starts from nothing, and the
same failure gets rediscovered from scratch. One line and a URL is a small price
against losing it. One occurrence is enough — a bug does not need to repeat to be
real.

Nothing about filing changes the task in front of you. Work around the bug the
way you would have anyway, and tell Marco what the workaround cost him.

## An improvement: finish first, then ask

Nothing is broken, but something would work better:

- Repeated session data contradicts a rule a document states.
- Following a procedure produces the same friction every time.
- A task keeps needing a judgment the documents leave unaddressed.
- New evidence Marco brings up — research, a coach's advice he trusts —
  conflicts with the method.

**Finish helping first. Then put it to Marco in a sentence or two and let him
decide.** File it only if he says so. These are opinions about how the system
should work, and they are his to hold, not yours to log.

Wait for a pattern before raising it at all: one observation is an anecdote. A
procedure that felt clumsy once is not evidence, and neither is a single session
that went against the method.

## How to file

Make at most one issue lookup and, if that succeeds, one filing or comment
attempt for this incident. If any reporting call fails, follow the stop rule below.
First check whether it is already open:

```bash
curl -s -H "$AUTH" "$BASE/issues"
```

If it is, add to it instead of filing again — a repeat is what turns one report
into a pattern, and split across two issues it reads as two anecdotes:

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/issues/12/comments" -d '{"note": "Happened again on 2026-08-24, same call, same 500."}'
```

Otherwise file it:

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/issues" -d '{
    "request_id": "<fresh uuid>",
    "kind": "bug",
    "title": "POST /sets 500s when target_reps is sent without reps",
    "problem": "What is wrong, in one paragraph.",
    "evidence": "Sanitized reproduction, sanitized response, dates; substitutions marked synthetic.",
    "suggestion": "Optional. What you think should change.",
    "docs": ["reference/sessions"]
  }'
```

- **`kind`** is `bug` or `improvement`. A bug is the system doing something
  wrong. An improvement is anything that would work better — including a
  document that has proven incomplete.
- **`evidence`** is required for a bug and optional for an improvement. Write
  down a reproducible, sanitized call and response, with relevant field names,
  status and timing. Mark redactions and synthetic substitutions; never include
  credentials or unnecessary health details. If reproduction is unavailable,
  say what is missing rather than inventing evidence.
- **`suggestion`** is welcome and is not binding. You are describing code you
  cannot read; say what would help, not what to write.
- **`docs`** names the documents involved, as `SKILL.md` lists them.
  Leave it out when none are.
- **`request_id`** is a fresh UUID per issue operation, kept stable if that same
  operation is later retried after reconciliation. Overlapping calls with the same
  ID serialize across API instances and a recorded ledger result replays. A crash
  can still happen after GitHub creates the issue but before the local ledger commits.
  This is not exactly-once delivery. Comments have no request-ID deduplication at all.

A successful response carries the issue URL and number. **Then tell Marco you filed it
and give him the URL** — a report he never hears about is the same as no report.
For a bug, say it in the same breath as the workaround and move on; do not turn
it into a discussion in the middle of his session.

## Reporting failure: stop, do not report the reporter

If lookup, filing or commenting fails (including 401 or 422), **stop reporting for
this incident**. Do not open another issue about it, refresh/retry inside the
reporting flow, or loop back to lookup. Tell Marco briefly which report could not
be filed and why, with sanitized details. For a timeout, lost response or 5xx after
an issue/comment write, say **delivery is unknown**, not that nothing was created.
Do not blindly retry: GitHub may already have accepted it, even with the same issue
UUID; comments can duplicate without any ledger. A later explicit reconciliation
can inspect the destination and decide what is missing; an inconclusive list is
not proof that an issue or comment was never created.

Continue the original task only if it remains safe and the record supports it;
otherwise explain what is blocked. Never claim an unsaved log was saved, and never
let this stop rule delay urgent symptom guidance. Reporting is not a prerequisite
for giving that guidance or helping safely without the broken operation.
