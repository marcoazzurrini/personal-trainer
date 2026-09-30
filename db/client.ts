import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";

/** Bind persistence to this invocation, never to a process-global environment. */
export function createClient(binding: D1Database) {
  return drizzle(binding);
}

export type Client = ReturnType<typeof createClient>;
