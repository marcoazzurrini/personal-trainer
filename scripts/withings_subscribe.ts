import { rm } from "node:fs/promises";

import { z } from "@hono/zod-openapi";

// Subscribe the deployed /api/withings/notify route after seeding D1.
// bun --no-env-file scripts/withings_subscribe.ts \
//   --remote --callback https://trainer.marcoazzurrini.com/api/withings/notify
// --local selects local D1, not a locally reachable provider callback.
//
// This operator only reads the access token. It never competes with the API to
// rotate refresh tokens. Run directly after seeding, or let the API refresh an
// expired token before subscribing. No credentials come from .env or arguments.
import { executeSql, privateWorkspace } from "./seed_withings.ts";

export function subscriptionOptions(args: string[]) {
  let target: "local" | "remote" | undefined;
  let callback: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--local" || args[i] === "--remote") && !target) {
      target = args[i] === "--local" ? "local" : "remote";
    } else if (args[i] === "--callback" && !callback) {
      i += 1;
      callback = args[i];
    } else {
      throw new Error("Unknown, repeated or conflicting subscription options.");
    }
  }
  if (!target || !callback) {
    throw new Error(
      "Require exactly one of --local/--remote and --callback <public HTTPS URL>."
    );
  }
  const url = new URL(callback);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/withings/notify"
  ) {
    throw new Error(
      "Callback must be a public HTTPS /api/withings/notify URL without credentials, query or fragment."
    );
  }
  return { target, callback: url.href };
}
type SubscriptionFetch = (url: string, init: RequestInit) => Promise<Response>;
export async function subscribe(
  options: ReturnType<typeof subscriptionOptions>,
  execute = executeSql,
  fetcher: SubscriptionFetch = fetch
): Promise<void> {
  const dir = await privateWorkspace();
  try {
    const [row] = await execute(
      options.target,
      "SELECT access_token, access_token_expires_at FROM withings_auth WHERE id = 1;",
      dir
    );
    const token = z.string().safeParse(row?.access_token);
    if (!token.success || !token.data.trim()) {
      throw new Error(
        "No access token in D1. Run scripts/seed_withings.ts first."
      );
    }
    const storedExpiry = z.string().safeParse(row?.access_token_expires_at);
    const expires = storedExpiry.success
      ? new Date(storedExpiry.data).getTime()
      : Number.NaN;
    if (!Number.isFinite(expires) || expires - Date.now() < 300_000) {
      throw new Error(
        "Stored token expires within five minutes. Let the API refresh it, or explicitly reseed with writers paused; this script never refreshes tokens."
      );
    }
    try {
      const response = await fetcher("https://wbsapi.withings.net/notify", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${token.data}`,
        },
        body: new URLSearchParams({
          action: "subscribe",
          callbackurl: options.callback,
          appli: "1",
          comment: "personal-trainer-sync",
        }),
      });
      const json = await response.json();
      if (!response.ok || json?.status !== 0) {
        throw new Error("Provider did not confirm the subscription.");
      }
    } catch {
      throw new Error(
        "Withings subscription failed or its outcome is uncertain. Provider details withheld; inspect the subscription before retrying."
      );
    }
  } finally {
    await rm(dir, { recursive: true });
  }
}
if (import.meta.main) {
  try {
    await subscribe(subscriptionOptions(process.argv.slice(2)));
    console.log("Subscribed the callback to Withings weight notifications.");
  } catch {
    // Do not expose URLs, provider bodies, SQL output or credentials in errors.
    console.error(
      "Subscription failed. Check explicit target, callback and freshly seeded D1 credentials. No refresh was attempted; a subscription may already have been created."
    );
    process.exitCode = 1;
  }
}
