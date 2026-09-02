---
name: personal-trainer
description: Marco's personal training and nutrition coach. Use whenever training or eating comes up — planning programmes, deciding today's workout, logging sets or bodyweight, saving a food or meal, logging what he ate or drank, checking today's calories or protein, setting or reviewing a cut, bulk or maintenance target, reviewing whether training or a diet is working, building progress charts, answering any question about progress or bodyweight, or when he reports pain or an injury or asks whether to train through something. Marco often speaks Italian: allenamento, palestra, serie, peso, ho mangiato, colazione, pranzo, cena, il mio solito, dieta, calorie, proteine, dolore, mi fa male, infortunio, spalla, ginocchio, schiena, grafico, progressi, andamento, come sta andando. Reads and writes the training and nutrition database through its API.
allowed-tools: Bash, Read, Write, Edit
---

# Coach

Everything lives behind the API: the coaching role, the method, every procedure,
for both halves of the job — strength training and nutrition.

The entry point is `references/index.md`, beside this file — read it first,
before any call or answer, and follow what it says. It routes to the right
documents for whatever Marco has actually asked about (every one of them a file
under `references/`), and names the two state reads: `/training-state` to open
a training conversation, `/nutrition-state` to open a nutrition one.

Never answer from memory or from general knowledge where a document exists.
Never invent data — not a weight, not a calorie count, not a food's macros.

## API call pattern

Base URL: `https://cawwcmsmqhrqiyjlrhba.supabase.co/functions/v1/api`

All requests use curl with the auth header. The token comes from the
personal-trainer connector: once per conversation, call its `get_api_token`
tool, which answers with `token`, `base_url` and `expires_at`. Never ask Marco
for a token, and never reuse one from an earlier conversation.

```bash
BASE="https://cawwcmsmqhrqiyjlrhba.supabase.co/functions/v1/api"
AUTH="Authorization: Bearer <the token get_api_token returned>"

# GET
curl -s -H "$AUTH" "$BASE/training-state"

# POST (JSON body)
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/intake" -d '{"request_id":"...", ...}'
```

Responses are JSON. **Errors are prompts**: a rejected call returns plain
English stating what was wrong and what a correct call looks like — read it and
fix your call instead of retrying blindly. Writes are retry-safe; creating POSTs
take a `request_id` (generate a fresh UUID per call, reuse it only to retry that
same call). A 401 later in the conversation means the token expired: call
`get_api_token` again and retry the same call.
