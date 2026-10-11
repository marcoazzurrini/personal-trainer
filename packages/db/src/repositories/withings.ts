import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import type { Client } from "../client.ts";
import { classifyDatabaseFailure } from "../errors.ts";
import { withings_auth } from "../schema/index.ts";

export interface WithingsAuth {
  withings_user_id: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
  last_sync_at: string | null;
}

export function withingsRepository(db: Client) {
  async function readAuth(): Promise<WithingsAuth | null> {
    try {
      const rows = await db
        .select({
          withings_user_id: withings_auth.withings_user_id,
          access_token: withings_auth.access_token,
          refresh_token: withings_auth.refresh_token,
          access_token_expires_at: withings_auth.access_token_expires_at,
          last_sync_at: withings_auth.last_sync_at,
        })
        .from(withings_auth)
        .where(eq(withings_auth.id, 1));
      return rows[0] ?? null;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function rotateCredentials(
    expected: Pick<
      WithingsAuth,
      "withings_user_id" | "access_token" | "refresh_token"
    >,
    replacement: {
      accessToken: string;
      refreshToken: string;
      expiresAt: string;
      updatedAt: string;
    }
  ): Promise<boolean> {
    try {
      const changed = await db
        .update(withings_auth)
        .set({
          access_token: replacement.accessToken,
          refresh_token: replacement.refreshToken,
          access_token_expires_at: replacement.expiresAt,
          updated_at: replacement.updatedAt,
        })
        .where(
          and(
            eq(withings_auth.id, 1),
            eq(withings_auth.withings_user_id, expected.withings_user_id),
            eq(withings_auth.refresh_token, expected.refresh_token),
            eq(withings_auth.access_token, expected.access_token)
          )
        )
        .returning({ id: withings_auth.id });
      return changed.length > 0;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function advanceWatermark(
    accountId: string,
    watermark: string,
    updatedAt: string
  ): Promise<boolean> {
    try {
      const changed = await db
        .update(withings_auth)
        .set({
          last_sync_at: sql`CASE WHEN ${withings_auth.last_sync_at} IS NULL OR ${withings_auth.last_sync_at} < ${watermark} THEN ${watermark} ELSE ${withings_auth.last_sync_at} END`,
          updated_at: updatedAt,
        })
        .where(
          and(
            eq(withings_auth.id, 1),
            eq(withings_auth.withings_user_id, accountId)
          )
        )
        .returning({ id: withings_auth.id });
      return changed.length > 0;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function claimCatchUp(
    at: string,
    before: string
  ): Promise<string | null> {
    try {
      const claimed = await db
        .update(withings_auth)
        .set({
          last_sync_attempt_at: at,
          updated_at: at,
        })
        .where(
          and(
            eq(withings_auth.id, 1),
            or(
              isNull(withings_auth.last_sync_attempt_at),
              lt(withings_auth.last_sync_attempt_at, before)
            )
          )
        )
        .returning({ withings_user_id: withings_auth.withings_user_id });
      return claimed[0]?.withings_user_id ?? null;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  return { readAuth, rotateCredentials, advanceWatermark, claimCatchUp };
}

export type WithingsRepository = ReturnType<typeof withingsRepository>;
