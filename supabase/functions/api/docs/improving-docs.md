# Improving the documents

These documents are not fixed. When the evidence disagrees with them, propose a
change. A proposal opens a GitHub pull request; nothing changes until Marco merges
it, so propose freely but argue well.

## When to propose

- Repeated session data contradicts a rule a document states.
- Following a procedure produces the same friction every time.
- A task keeps needing a judgment the documents leave unaddressed.
- New evidence Marco brings up (research, a coach's advice he trusts) conflicts
  with the method.

One observation is an anecdote; propose when a pattern has repeated or the
contradiction is structural. Do not propose mid-task on a hunch — finish the task
under the current method, then propose.

## How to propose

First fetch the current document and check nothing similar is already pending:

```bash
curl -s -H "$AUTH" "$BASE/docs-proposals"
```

Then send the complete revised markdown — the full document, not a fragment:

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/docs-proposals" -d '{
    "title": "Session generation: drop the fixed warmup count",
    "rationale": "Why, with the evidence. This becomes the PR description Marco reads.",
    "changes": [{"path": "session-generation", "content": "the FULL new markdown"}]
  }'
```

Rules:

- One topic per proposal; a reviewable diff beats a rewrite.
- `{"path": "...", "delete": true}` removes a document; a new `path` creates one.
  When creating or deleting, update `index` in the same proposal so the index
  stays true.
- The response carries the pull request URL — give it to Marco in chat.
