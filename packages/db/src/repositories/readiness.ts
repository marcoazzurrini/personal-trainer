import { sql } from "drizzle-orm";

import type { Client } from "../client.ts";
import { classifyDatabaseFailure } from "../errors.ts";

export function readinessRepository(db: Client) {
  return {
    async check(): Promise<void> {
      try {
        await db.get(sql`select 1`);
      } catch (error) {
        throw classifyDatabaseFailure(error);
      }
    },
  };
}
