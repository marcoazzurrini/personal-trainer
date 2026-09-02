// Seeds the single withings_auth row from a refresh token obtained by hand.
//
// Run once per environment. Nothing secret is passed on the command line; it all
// comes from .env at the repo root, which git already ignores: the Withings
// client, the refresh token, and DATABASE_URL naming the database to seed.
//
//   deno run --allow-net --allow-read --allow-env --allow-sys \
//     scripts/seed_withings.ts
//
// To reach the hosted database, put its URL in .env as DATABASE_URL for the
// run (through an SSH tunnel, since it is not on the internet) and put the
// local one back after. The refresh token is needed for this one write and
// never again — from here the server keeps its own tokens up to date.
//
// DATABASE_URL in the environment wins over the file, for a throwaway target
// that is not worth editing the file for.

import postgres from "postgres";
import { refreshTokens } from "../api/body/withings_client.ts";

const ENV_PATH = ".env";
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

const env = parseEnv(await Deno.readTextFile(ENV_PATH));

// Why the database URL is not typed on the command line: the shell records
// what was typed, and a password pasted into a terminal outlives the task by
// years in ~/.zsh_history. The env file is one place the repository already
// keeps out of git.
function databaseUrl(): string {
  const url = Deno.env.get("DATABASE_URL") ?? env.DATABASE_URL;
  if (!url) {
    console.error(
      `Set DATABASE_URL in ${ENV_PATH} to name the database to seed.`,
    );
    Deno.exit(1);
  }
  return url;
}

const target = databaseUrl();
const cfg = {
  apiBase: API_BASE,
  clientId: required(env, "WITHINGS_CLIENT_ID"),
  clientSecret: required(env, "WITHINGS_CLIENT_SECRET"),
};
const withingsUserId = required(env, "WITHINGS_USER_ID");
const refreshToken = required(env, "WITHINGS_REFRESH_TOKEN");

console.log(`Seeding ${new URL(target).host} for user ${withingsUserId}.`);

const db = postgres(target);
try {
  // Reach the database before spending the refresh token. The other order works
  // and reads worse on failure: a wrong password would burn a Withings call and
  // report a database error, leaving it unclear whether the token was consumed.
  await db`select 1`;

  const tokens = await refreshTokens(cfg, refreshToken);
  console.log(
    `Token refreshed; it expires at ${tokens.expiresAt}. Refresh token ${
      tokens.refreshToken === refreshToken ? "came back unchanged" : "rotated"
    }.`,
  );

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
