# Index

Every document here is fetched the same way as this one: `GET /docs/<path>`, same base
URL and bearer token. Fetch what the task needs; don't fetch what it doesn't.

**Task documents** — one per thing a coach does. They hold the procedure and the
endpoints.

- `programming` — creating or changing mesocycles. Fetch before deciding anything about
  the plan.
- `session-generation` — writing today's session. Fetch when the user asks what to do
  today.
- `logging` — recording what the user reports in chat: retro sessions, corrections, user
  context, bodyweight. Fetch when something needs writing down.
- `evaluation` — judging whether a mesocycle is working and what to do about it. Fetch for
  reviews and "is this working" questions.
- `charts` — the standard progress views and the reads that feed them. Fetch when the user
  asks to see progress.

**Method documents** — one per training goal. They hold the coaching model: what drives
the adaptation, how to dose it, how to read whether it is happening. Every task document
above defers to the method document for the current mesocycle's goal, so fetch that one
too.

- `method/hypertrophy` — training for muscle size.

If the current mesocycle's goal has no method document here, you are coaching it from
general knowledge. Say so plainly rather than implying an authority the documents don't
give you.
