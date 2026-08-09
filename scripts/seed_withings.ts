// Seeds the single withings_auth row from a refresh token obtained by hand.
//
// Run once per environment. Everything it needs that is secret comes from
// supabase/functions/.env (gitignored); the database it writes to must be named
// explicitly, because the difference between the local stack and production is
// one hostname and getting it wrong here is silent.
//
// Usage:
//   DATABASE_URL=<the pooler URL> deno run \
//     --allow-net --allow-read --allow-env scripts/seed_withings.ts

import postgres from "postgres";
import { refreshTokens } from "../supabase/functions/api/lib/withings.ts";

const ENV_PATH = "supabase/functions/.env";
const API_BASE = "https://wbsapi.withings.net";

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

function required(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) {
    console.error(`${key} is missing from ${ENV_PATH}.`);
    Deno.exit(1);
  }
  return value;
}

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not set. Pass the database to seed explicitly — this script writes credentials, and defaulting it would make writing them to the wrong database the quiet outcome.",
  );
  Deno.exit(1);
}

const env = parseEnv(await Deno.readTextFile(ENV_PATH));
const cfg = {
  apiBase: API_BASE,
  clientId: required(env, "WITHINGS_CLIENT_ID"),
  clientSecret: required(env, "WITHINGS_CLIENT_SECRET"),
};
const withingsUserId = required(env, "WITHINGS_USER_ID");
const refreshToken = required(env, "WITHINGS_REFRESH_TOKEN");

console.log(`Seeding ${new URL(databaseUrl).host} for user ${withingsUserId}.`);

// This consumes the refresh token. If Withings rotates it, the value in .env is
// dead from here on and the database holds the live one — which is the point of
// the table, and why the seed is the last time .env matters.
const tokens = await refreshTokens(cfg, refreshToken);
console.log(
  `Token refreshed; it expires at ${tokens.expiresAt}. Refresh token ${
    tokens.refreshToken === refreshToken ? "came back unchanged" : "rotated"
  }.`,
);

const db = postgres(databaseUrl, { prepare: false });
try {
  await db`
    insert into withings_auth (
      id, withings_user_id, access_token, refresh_token,
      access_token_expires_at
    ) values (
      1, ${withingsUserId}, ${tokens.accessToken},
      ${tokens.refreshToken}, ${tokens.expiresAt}
    )
    on conflict (id) do update set
      withings_user_id = excluded.withings_user_id,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      access_token_expires_at = excluded.access_token_expires_at,
      updated_at = now()`;
  console.log("withings_auth seeded. last_sync_at is null, so the first");
  console.log("catch-up will import the full history.");
} finally {
  await db.end();
}
