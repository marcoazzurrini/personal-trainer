import { and, eq, gt, lt } from "drizzle-orm";

import type { Client } from "../client.ts";
import { classifyDatabaseFailure } from "../errors.ts";
import { api_tokens } from "../schema/index.ts";

export interface HashedToken {
  token_hash: string;
  subject: string;
  issued_at: string;
  expires_at: string;
}

export function accessRepository(db: Client) {
  async function insertToken(token: HashedToken): Promise<void> {
    try {
      await db.insert(api_tokens).values(token);
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function deleteExpiredTokens(now: string): Promise<void> {
    try {
      await db.delete(api_tokens).where(lt(api_tokens.expires_at, now));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function findActiveToken(
    tokenHash: string,
    now: string
  ): Promise<{ subject: string } | null> {
    try {
      const rows = await db
        .select({ subject: api_tokens.subject })
        .from(api_tokens)
        .where(
          and(
            eq(api_tokens.token_hash, tokenHash),
            gt(api_tokens.expires_at, now)
          )
        );
      return rows[0] ?? null;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  return { insertToken, deleteExpiredTokens, findActiveToken };
}

export type AccessRepository = ReturnType<typeof accessRepository>;
