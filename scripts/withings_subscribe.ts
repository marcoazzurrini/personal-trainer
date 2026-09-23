// Subscribe the deployed /api/withings/notify route after seeding D1.
// deno run --allow-read --allow-write --allow-env --allow-run=node \
//   --allow-net=wbsapi.withings.net scripts/withings_subscribe.ts \
//   --remote --callback https://trainer.marcoazzurrini.com/api/withings/notify
// --local selects local D1, not a locally reachable provider callback.
//
// This operator only reads the access token. It never competes with the API to
// rotate refresh tokens. Run directly after seeding, or let the API refresh an
// expired token before subscribing. No credentials come from .env or arguments.

import { executeSql, privateWorkspace } from "./seed_withings.ts";

export function subscriptionOptions(
  args: string[],
): { target: "local" | "remote"; callback: string } {
  let target: "local" | "remote" | undefined;
  let callback: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--local" || args[i] === "--remote") && !target) {
      target = args[i] === "--local" ? "local" : "remote";
    } else if (args[i] === "--callback" && !callback) {
      callback = args[++i];
    } else {
      throw new Error("Unknown, repeated or conflicting subscription options.");
    }
  }
  if (!target || !callback) {
    throw new Error(
      "Require exactly one of --local/--remote and --callback <public HTTPS URL>.",
    );
  }
  const url = new URL(callback);
  if (
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash || url.pathname !== "/api/withings/notify"
  ) {
    throw new Error(
      "Callback must be a public HTTPS /api/withings/notify URL without credentials, query or fragment.",
    );
  }
  return { target, callback: url.href };
}

export async function subscribe(
  options: ReturnType<typeof subscriptionOptions>,
  execute = executeSql,
  fetcher = fetch,
): Promise<void> {
  const dir = await privateWorkspace();
  try {
    const [row] = await execute(
      options.target,
      "SELECT access_token, access_token_expires_at FROM withings_auth WHERE id = 1;",
      dir,
    );
    if (
      !row || typeof row.access_token !== "string" || !row.access_token.trim()
    ) {
      throw new Error(
        "No access token in D1. Run scripts/seed_withings.ts first.",
      );
    }
    const expires = typeof row.access_token_expires_at === "string"
      ? new Date(row.access_token_expires_at).getTime()
      : NaN;
    if (!Number.isFinite(expires) || expires - Date.now() < 300_000) {
      throw new Error(
        "Stored token expires within five minutes. Let the API refresh it, or explicitly reseed with writers paused; this script never refreshes tokens.",
      );
    }
    try {
      const response = await fetcher("https://wbsapi.withings.net/notify", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${row.access_token}`,
        },
        body: new URLSearchParams({
          action: "subscribe",
          callbackurl: options.callback,
          appli: "1",
          comment: "personal-trainer-sync",
        }),
      });
      const json = await response.json();
      if (!response.ok || json?.status !== 0) throw new Error();
    } catch {
      throw new Error(
        "Withings subscription failed or its outcome is uncertain. Provider details withheld; inspect the subscription before retrying.",
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

if (import.meta.main) {
  try {
    await subscribe(subscriptionOptions(Deno.args));
    console.log("Subscribed the callback to Withings weight notifications.");
  } catch {
    // Do not expose URLs, provider bodies, SQL output or credentials in errors.
    console.error(
      "Subscription failed. Check explicit target, callback and freshly seeded D1 credentials. No refresh was attempted; a subscription may already have been created.",
    );
    Deno.exitCode = 1;
  }
}
