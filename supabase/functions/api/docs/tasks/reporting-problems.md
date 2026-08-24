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

## When to file

- A call failed, or returned something that cannot be right.
- An error message told you to do something that did not work.
- The API has no way to record something that actually happened.
- Repeated session data contradicts a rule a document states.
- Following a procedure produces the same friction every time.
- A task keeps needing a judgment the documents leave unaddressed.
- New evidence Marco brings up — research, a coach's advice he trusts —
  conflicts with the method.

A bug is worth filing the first time it happens. Everything else is worth filing
once it has repeated or the contradiction is structural: one observation is an
anecdote. Never file mid-task — finish under the current method, then file.

## How to file

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

The response carries the issue URL and number — give the URL to Marco in chat.
