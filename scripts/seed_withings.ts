// Seeds the single withings_auth row from a refresh token obtained by hand.
//
// Run once per environment. Nothing secret is passed on the command line; it all
// comes from supabase/functions/.env, which git already ignores.
//
// To seed the linked project, put its database password in that file as
// DB_PASSWORD and run:
//
//   deno run --allow-net --allow-read --allow-env --allow-sys \
//     scripts/seed_withings.ts
//
// Then delete the line. The password is needed for this one write and never
// again — from here the server keeps its own tokens up to date.
//
// To seed the local stack instead, name it explicitly:
//
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     deno run --allow-net --allow-read --allow-env --allow-sys \
//     scripts/seed_withings.ts

import postgres from "postgres";
import { refreshTokens } from "../api/body/withings_client.ts";

const ENV_PATH = "supabase/functions/.env";
const POOLER_PATH = "supabase/.temp/pooler-url";
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

// Where the database password comes from, and why not from the command line.
//
// The obvious way to run this is DATABASE_URL=postgresql://...:<password>@...
// in front of the command, and it is wrong for one boring reason: the shell
// records what was typed. A password pasted into a terminal outlives the task by
// years, sitting in ~/.zsh_history, readable by anything that can read the home
// directory. Taking it from the gitignored env file instead means it exists in
// one place the repository already knows to keep out of git, and can be deleted
// the moment this has run.
//
// DATABASE_URL still wins when it is set, because the local stack is seeded with
// a throwaway URL that is not worth putting in a file.
function databaseUrl(): string {
  const explicit = Deno.env.get("DATABASE_URL");
  if (explicit) return explicit;

  const password = env.DB_PASSWORD ?? env.SUPABASE_DB_PASSWORD;
  if (!password) {
    console.error(
      `Set DB_PASSWORD in ${ENV_PATH} (the project's database password), or set DATABASE_URL to name a database explicitly.`,
    );
    Deno.exit(1);
  }
  // Written by `supabase link`, and carries the user and host of the linked
  // project without its password — which is exactly the missing half.
  let pooler: string;
  try {
    pooler = Deno.readTextFileSync(POOLER_PATH).trim();
  } catch {
    console.error(
      `${POOLER_PATH} is missing. Run \`supabase link --project-ref <ref>\` first, or set DATABASE_URL.`,
    );
    Deno.exit(1);
  }
  const url = new URL(pooler);
  url.password = password;
  return url.toString();
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

const db = postgres(target, { prepare: false });
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
