# Reporting a problem

Neither these documents nor the API behind them are fixed. When something in the
system is in the way — a call that failed, a number that came back wrong, an
error message that sent you somewhere useless, a procedure that produces the same
friction every time — file an issue. Marco reads it and the change is written
from the repository, where the code and its tests can actually be seen.

You do not edit anything here. You report. That split is deliberate: you have the
conversations and none of the repository, so the thing only you can produce is
evidence — what you called, what came back, how often, what it cost the session.
The diagnosis and the fix belong where the code is visible.

## A bug: file it immediately, then carry on

The system did something wrong:

- A call failed, or returned something that cannot be right.
- An error message told you to do something that did not work.
- The API has no way to record something that actually happened.

**File it the moment you see it, even in the middle of a task.** Do not wait for
the conversation to end and do not ask first. Then say in one line that you filed
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

First check whether it is already open — one call, and it costs a bug report
almost nothing:

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
    "evidence": "The exact call, the exact response, the dates it happened.",
    "suggestion": "Optional. What you think should change.",
    "docs": ["reference/sessions"]
  }'
```

- **`kind`** is `bug` or `improvement`. A bug is the system doing something
  wrong. An improvement is anything that would work better — including a
  document that has proven incomplete.
- **`evidence`** is required for a bug and optional for an improvement. Write
  down the call and the response verbatim, not a summary of them: nobody can
  reproduce a bug from a paraphrase, and a bug that cannot be reproduced cannot
  be fixed. If you cannot show it, file it as an improvement and say what you
  suspect.
- **`suggestion`** is welcome and is not binding. You are describing code you
  cannot read; say what would help, not what to write.
- **`docs`** names the documents involved, as `GET /docs/index` writes them.
  Leave it out when none are.
- **`request_id`** is a fresh UUID, as on every creating call. Resending it
  returns the issue you already filed instead of filing a second.

The response carries the issue URL and number. **Always tell Marco you filed it
and give him the URL** — a report he never hears about is the same as no report.
For a bug, say it in the same breath as the workaround and move on; do not turn
it into a discussion in the middle of his session.
