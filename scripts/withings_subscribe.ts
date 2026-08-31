// Subscribes the deployed /api/withings/notify route to weight notifications.
//
// Run once, after the function is live — Withings probes the callback URL as
// part of subscribing, so doing this before deploying fails. Re-running is
// harmless; Withings replaces an existing subscription for the same callback.
//
// Usage:
//   DATABASE_URL=<the pooler URL> CALLBACK_URL=https://<project>.supabase.co/functions/v1/api/withings/notify \
//     deno run --allow-net --allow-read --allow-env scripts/withings_subscribe.ts
//
// Credentials come from the database rather than .env: after seeding, that row
// is the only place the live tokens exist.

import postgres from "postgres";
import { refreshTokens } from "../supabase/functions/api/outside/withings.ts";

const API_BASE = "https://wbsapi.withings.net";
const APPLI_WEIGHT = "1";

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq !== -1) out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

const databaseUrl = Deno.env.get("DATABASE_URL");
const callbackUrl = Deno.env.get("CALLBACK_URL");
if (!databaseUrl || !callbackUrl) {
  console.error("DATABASE_URL and CALLBACK_URL are both required.");
  Deno.exit(1);
}

const env = parseEnv(await Deno.readTextFile("supabase/functions/.env"));
const cfg = {
  apiBase: API_BASE,
  clientId: env.WITHINGS_CLIENT_ID,
  clientSecret: env.WITHINGS_CLIENT_SECRET,
};

const db = postgres(databaseUrl, { prepare: false });
let accessToken: string;
try {
  const [row] = await db`
    select access_token, refresh_token, access_token_expires_at
    from withings_auth where id = 1`;
  if (!row) {
    console.error(
      "withings_auth is empty. Run scripts/seed_withings.ts first.",
    );
    Deno.exit(1);
  }
  // Refresh only when the stored token is close to spent, mirroring the
  // server's own rule. Refreshing unconditionally looks safer and is not:
  // Withings answers status 601, "Same arguments in less than 10 seconds", to a
  // repeated refresh, so this script run straight after seed_withings.ts — the
  // documented order, and the order anyone setting this up will use — would
  // fail on a rate limit that has nothing to do with subscribing.
  const spent = row.access_token_expires_at.getTime() - Date.now() < 300_000;
  if (!spent) {
    accessToken = row.access_token;
  } else {
    const tokens = await refreshTokens(cfg, row.refresh_token);
    await db`
      update withings_auth
      set access_token = ${tokens.accessToken},
          refresh_token = ${tokens.refreshToken},
          access_token_expires_at = ${tokens.expiresAt},
          updated_at = now()
      where id = 1`;
    accessToken = tokens.accessToken;
  }
} finally {
  await db.end();
}

async function notify(params: Record<string, string>): Promise<unknown> {
  const res = await fetch(`${API_BASE}/notify`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${accessToken}`,
    },
    body: new URLSearchParams(params),
  });
  const json = await res.json();
  // status, not the HTTP code — Withings answers 200 to its own refusals.
  if (json.status !== 0) {
    console.error(`Withings refused: ${JSON.stringify(json)}`);
    Deno.exit(1);
  }
  return json.body;
}

await notify({
  action: "subscribe",
  callbackurl: callbackUrl,
  appli: APPLI_WEIGHT,
  comment: "personal-trainer-sync",
});
console.log(`Subscribed ${callbackUrl} to appli ${APPLI_WEIGHT}.`);

const list = await notify({ action: "list", appli: APPLI_WEIGHT });
console.log("Current subscriptions:");
console.log(JSON.stringify(list, null, 2));
