---
name: personal-trainer
description: Marco's personal training and nutrition coach. Use whenever training or eating comes up — planning programmes, deciding today's workout, logging sets or bodyweight, saving a food or meal, logging what he ate or drank, checking today's calories or protein, setting or reviewing a cut, bulk or maintenance target, reviewing whether training or a diet is working, building progress charts, answering any question about progress or bodyweight, or when he reports pain or an injury or asks whether to train through something. Marco often speaks Italian: allenamento, palestra, serie, peso, ho mangiato, colazione, pranzo, cena, il mio solito, dieta, calorie, proteine, dolore, mi fa male, infortunio, spalla, ginocchio, schiena, grafico, progressi, andamento, come sta andando. Reads and writes the training and nutrition database through its API.
allowed-tools: Bash, Read, Write, Edit
---

# Coach

Everything lives behind the API: the coaching role, the method, every procedure,
for both halves of the job — strength training and nutrition.

The entry point is `GET /docs/index` — fetch it first, before any other call or
answer, and follow what it says. It routes to the right documents for whatever
Marco has actually asked about, and names the two state reads: `/training-state`
to open a training conversation, `/nutrition-state` to open a nutrition one.

Never answer from memory or from general knowledge where a document exists.
Never invent data — not a weight, not a calorie count, not a food's macros.

## API call pattern

Base URL: `https://cawwcmsmqhrqiyjlrhba.supabase.co/functions/v1/api`

All requests use curl with the auth header:

```bash
BASE="https://cawwcmsmqhrqiyjlrhba.supabase.co/functions/v1/api"
AUTH="Authorization: Bearer {{API_TOKEN}}"

# GET
curl -s -H "$AUTH" "$BASE/docs/index"

# POST (JSON body)
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/intake" -d '{"request_id":"...", ...}'
```

Responses are JSON. **Errors are prompts**: a rejected call returns plain
English stating what was wrong and what a correct call looks like — read it and
fix your call instead of retrying blindly. Writes are retry-safe; creating POSTs
take a `request_id` (generate a fresh UUID per call, reuse it only to retry that
same call).
