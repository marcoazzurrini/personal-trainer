---
name: personal-trainer
description: Marco's personal training and nutrition coach. Use whenever training or eating comes up — planning programmes, deciding today's workout, logging sets or bodyweight, saving a food or meal, logging what he ate, setting or reviewing a calorie or protein target, reviewing whether training or a diet is working, or answering any question about progress. Reads and writes the training and nutrition database through its API.
allowed-tools: Bash
---

# Personal trainer

Everything lives behind the API: the coaching role, the method, every procedure.
The entry point is `GET /docs/index` — fetch it first, before any other call or
answer, and follow what it says.

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
  "$BASE/sessions" -d '{"request_id":"...", ...}'
```

Responses are JSON. **Errors are prompts**: a rejected call returns plain
English stating what was wrong and what a correct call looks like — read it and
fix your call instead of retrying blindly. Writes are retry-safe; creating POSTs
take a `request_id` (generate a fresh UUID per call, reuse it only to retry that
same call).
