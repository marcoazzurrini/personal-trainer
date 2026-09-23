// One-time D1 seeding, using the root package-lock.json's installed Wrangler.
// First run npm ci and apply D1 migrations. Stop AND drain every Withings writer
// (notifications, scheduled/manual sync, old deployments and operator scripts)
// before acknowledging --writers-paused. The flag is not a distributed lock.
//
// deno run --allow-read --allow-write --allow-env --allow-run=node \
//   --allow-net=wbsapi.withings.net scripts/seed_withings.ts \
//   --local --secrets /private/withings.json --writers-paused
// Use --remote instead of --local only for the intended hosted D1 database.
// The explicit, owner-only JSON file contains WITHINGS_CLIENT_ID,
// WITHINGS_CLIENT_SECRET, WITHINGS_USER_ID and WITHINGS_REFRESH_TOKEN strings.
// No .env is read; runtime configuration belongs in .dev.vars / Worker secrets.
//
// After a failed save, keep writers paused. A receipt containing returned tokens
// stays in the printed private .env.withings-* directory (git ignored). Never
// upload that directory as an artifact, paste it in logs, or commit it. Retry
// ONLY persistence, without spending another refresh token, with the same target:
//   ... --remote --secrets <private-directory>/receipt.json --writers-paused --recover
// A failed/timed-out provider call may already have rotated credentials. An
// "uncertain" receipt cannot recover tokens the provider never delivered. Inspect
// the account / reauthorize rather than blindly retrying the original token.
// Filesystem failure or process termination between refresh and receipt sync can
// also lose returned credentials. A receipt is not a provider transaction.

import { fileURLToPath } from "node:url";
import { refreshTokens, type TokenSet } from "../api/body/withings_client.ts";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DATABASE = "personal-trainer";
type Target = "local" | "remote";
export interface Options {
  target: Target;
  secrets: string;
  recover: boolean;
}

export function parseOptions(args: string[]): Options {
  let target: Target | undefined;
  let secrets: string | undefined;
  let paused = false;
  let recover = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--local" || arg === "--remote") && !target) {
      target = arg === "--local" ? "local" : "remote";
    } else if (arg === "--secrets" && !secrets) {
      secrets = args[++i];
      if (!secrets || secrets.startsWith("--")) {
        throw new Error("Missing secret file.");
      }
    } else if (arg === "--writers-paused" && !paused) {
      paused = true;
    } else if (arg === "--recover" && !recover) {
      recover = true;
    } else {
      throw new Error(
        "Unknown, repeated or conflicting options; never pass credentials as arguments.",
      );
    }
  }
  if (!target || !secrets || !paused) {
    throw new Error(
      "Require exactly one of --local/--remote, --secrets <private JSON file> and --writers-paused after stopping and draining all Withings writers.",
    );
  }
  return { target, secrets, recover };
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(
      "Required credential fields must be nonempty strings without NUL.",
    );
  }
  return value;
}
function quote(value: string): string {
  return `'${text(value).replaceAll("'", "''")}'`;
}
function timestamp(value: string): string {
  const iso = new Date(value).toISOString();
  if (!/^\d{4}-/.test(iso) || iso.startsWith("0000")) {
    throw new Error("Invalid expiry.");
  }
  return iso.replace("Z", "000Z");
}

export function seedSql(
  userId: string,
  tokens: TokenSet,
  now = new Date(),
): string {
  // Reset both checkpoints even on reseed: a replacement account must not inherit
  // another account's watermark, and the first catch-up must not be delayed.
  // Existing measurements remain untouched; the API deduplicates their replay.
  return `INSERT INTO withings_auth
    (id, withings_user_id, access_token, refresh_token, access_token_expires_at,
     last_sync_at, last_sync_attempt_at, updated_at)
    VALUES (1, ${quote(userId)}, ${quote(tokens.accessToken)}, ${
    quote(tokens.refreshToken)
  },
      ${quote(timestamp(tokens.expiresAt))}, NULL, NULL, ${
    quote(timestamp(now.toISOString()))
  })
    ON CONFLICT (id) DO UPDATE SET
      withings_user_id = excluded.withings_user_id,
      access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      access_token_expires_at = excluded.access_token_expires_at,
      last_sync_at = NULL, last_sync_attempt_at = NULL, updated_at = excluded.updated_at;`;
}

export async function privateWorkspace(): Promise<string> {
  // .env.* is already ignored. Never use dist/ or a CI artifact directory.
  const dir = await Deno.makeTempDir({ dir: ROOT, prefix: ".env.withings-" });
  await Deno.chmod(dir, 0o700);
  return dir;
}

export async function privateWrite(
  path: string,
  contents: string,
): Promise<void> {
  const file = await Deno.open(path, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  try {
    const bytes = new TextEncoder().encode(contents);
    let offset = 0;
    while (offset < bytes.length) {
      offset += await file.write(bytes.subarray(offset));
    }
    await file.sync();
  } finally {
    file.close();
  }
}

export function wranglerCommand(
  target: Target,
  file: string,
  dir: string,
): Deno.CommandOptions {
  return {
    cwd: ROOT,
    args: [
      `${ROOT}node_modules/wrangler/bin/wrangler.js`,
      "d1",
      "execute",
      DATABASE,
      `--${target}`,
      "--config",
      `${ROOT}wrangler.jsonc`,
      "--file",
      file,
      "--json",
      "--yes",
    ],
    env: {
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_WRITE_LOGS: "false",
      WRANGLER_LOG_SANITIZE: "true",
      WRANGLER_LOG_PATH: `${dir}/wrangler.log`,
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  };
}

type Command = (
  options: Deno.CommandOptions,
) => Promise<{ success: boolean; stdout: Uint8Array }>;
export async function executeSql(
  target: Target,
  sql: string,
  dir: string,
  command: Command = (options) => new Deno.Command("node", options).output(),
): Promise<Record<string, unknown>[]> {
  const file = `${dir}/${crypto.randomUUID()}.sql`;
  try {
    await privateWrite(file, sql);
    const output = await command(wranglerCommand(target, file, dir));
    if (!output.success) throw new Error();
    const result = JSON.parse(new TextDecoder().decode(output.stdout));
    if (
      !Array.isArray(result) || !result.length ||
      result.some((r) => r.success !== true || !Array.isArray(r.results))
    ) {
      throw new Error();
    }
    return result.flatMap((r) => r.results);
  } catch {
    // Wrangler may include the entire SQL (and therefore tokens) in an error.
    throw new Error(
      "D1 command failed; output withheld because it may contain credentials.",
    );
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

async function readSecrets(path: string): Promise<Record<string, unknown>> {
  try {
    const stat = await Deno.lstat(path);
    if (!stat.isFile || stat.mode === null || (stat.mode & 0o077) !== 0) {
      throw new Error();
    }
    const json = JSON.parse(await Deno.readTextFile(path));
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error();
    }
    return json;
  } catch {
    throw new Error(
      "Cannot read secret file: require a regular owner-only JSON file (chmod 600), not a symlink.",
    );
  }
}

interface Dependencies {
  execute?: typeof executeSql;
  refresh?: typeof refreshTokens;
}
export async function seed(
  options: Options,
  deps: Dependencies = {},
): Promise<void> {
  const input = await readSecrets(options.secrets);
  const userId = text(options.recover ? input.userId : input.WITHINGS_USER_ID);
  const cfg = options.recover ? null : {
    apiBase: "https://wbsapi.withings.net",
    clientId: text(input.WITHINGS_CLIENT_ID),
    clientSecret: text(input.WITHINGS_CLIENT_SECRET),
  };
  const original = options.recover ? null : text(input.WITHINGS_REFRESH_TOKEN);
  let tokens: TokenSet | undefined;
  if (options.recover) {
    if (
      input.target !== options.target || input.database !== DATABASE ||
      !input.tokens
    ) {
      throw new Error(
        "Receipt does not match the explicit target or contains no returned tokens. Do not retry an uncertain provider refresh blindly.",
      );
    }
    tokens = input.tokens as TokenSet;
    seedSql(userId, tokens); // Validate before opening the destination.
  }
  const execute = deps.execute ?? executeSql;
  const dir = await privateWorkspace();
  let refreshed = false;
  let saved = false;
  let receiptWritten = false;
  try {
    // Read the actual table AND exercise write access without changing its rows.
    // This also fails before refresh when migrations or required columns are absent.
    await execute(
      options.target,
      `UPDATE withings_auth SET
      withings_user_id = withings_user_id, access_token = access_token,
      refresh_token = refresh_token, access_token_expires_at = access_token_expires_at,
      last_sync_at = last_sync_at, last_sync_attempt_at = last_sync_attempt_at,
      updated_at = updated_at WHERE id = 1 AND 0;
      SELECT id FROM withings_auth WHERE id = 1;`,
      dir,
    );
    // Prove receipt creation works before consuming a provider refresh token.
    await privateWrite(
      `${dir}/uncertain.json`,
      JSON.stringify({
        target: options.target,
        database: DATABASE,
        userId,
        outcome:
          "No durable returned tokens here. A provider refresh may already have occurred; inspect before retrying.",
      }),
    );
    if (!tokens) {
      refreshed = true; // Includes timeouts and malformed provider responses.
      tokens = await (deps.refresh ?? refreshTokens)(cfg!, original!);
    }
    await privateWrite(
      `${dir}/receipt.json`,
      JSON.stringify({
        target: options.target,
        database: DATABASE,
        userId,
        tokens,
      }),
    );
    receiptWritten = true;
    await execute(options.target, seedSql(userId, tokens), dir);
    saved = true;
  } catch {
    if (receiptWritten) {
      throw new Error(
        `D1 save failed or its outcome is uncertain. Keep writers paused. Returned credentials remain in ${dir}/receipt.json; use --recover with the same target, not another provider refresh.`,
      );
    }
    if (refreshed) {
      throw new Error(
        `Provider refresh may already have occurred, but no complete receipt was confirmed. Keep writers paused; inspect ${dir} privately and recover/re-authorize before retrying. Provider and filesystem details withheld.`,
      );
    }
    throw new Error(
      "Preflight failed; no provider refresh was attempted. Check the explicit secret file, installed root Wrangler, D1 authentication and migrations. Details withheld.",
    );
  } finally {
    if (saved || (!refreshed && !receiptWritten)) {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

if (import.meta.main) {
  try {
    await seed(parseOptions(Deno.args));
    console.log(
      "withings_auth seeded in the explicit D1 target. Both catch-up checkpoints reset; the next catch-up imports full history. Resume writers after verification.",
    );
  } catch (error) {
    // Only script-owned diagnostics escape; command/provider errors are replaced.
    console.error(
      error instanceof Error
        ? error.message
        : "Seeding failed; details withheld.",
    );
    Deno.exitCode = 1;
  }
}
