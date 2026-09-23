import {
  type Clock,
  type Database,
  instant,
  rows,
  type Statement,
  statement,
  systemClock,
} from "../shared/d1.ts";
import { ApiError } from "../shared/errors.ts";
import { bodyweightStore } from "./bodyweight.ts";
import {
  getWeights,
  type MeasureRange,
  NOTIFY_WINDOW_MARGIN_S,
  refreshTokens,
  selectWeights,
  type WithingsConfig,
  WithingsError,
} from "./withings_client.ts";

export const WITHINGS_SOURCE = "withings";
const EXPIRY_MARGIN_MS = 60_000;
const CATCH_UP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Server configuration only. Missing credentials fail when a sync is attempted. */
export interface WithingsStoreConfig {
  apiBase?: string;
  clientId?: string;
  clientSecret?: string;
}
export interface SyncSummary {
  range: string;
  fetched: number;
  written: number;
  duplicate: number;
  ignored: number;
  refused: number;
}
interface AuthRow {
  withings_user_id: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
  last_sync_at: string | null;
}

/** Request-bound persistence. The caller owns all work through await or waitUntil. */
export function withingsStore(
  db: Database,
  config: WithingsStoreConfig,
  clock: Clock = systemClock,
) {
  const now = () => instant(clock().toISOString());
  function clientConfig(): WithingsConfig {
    if (!config.clientId || !config.clientSecret) {
      throw new WithingsError(
        "WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are not set on the server, so no call to Withings can be authenticated.",
      );
    }
    return {
      apiBase: config.apiBase ?? "https://wbsapi.withings.net",
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    };
  }
  async function readAuth(): Promise<AuthRow | null> {
    return (
      (
        await rows<AuthRow>(
          db,
          `SELECT withings_user_id, access_token, refresh_token,
      access_token_expires_at, last_sync_at FROM withings_auth WHERE id = 1`,
        )
      )[0] ?? null
    );
  }
  async function accessTokenFor(
    cfg: WithingsConfig,
    auth: AuthRow,
  ): Promise<string> {
    if (
      new Date(auth.access_token_expires_at).getTime() - clock().getTime() >
        EXPIRY_MARGIN_MS
    ) {
      return auth.access_token;
    }
    const tokens = await refreshTokens(
      cfg,
      auth.refresh_token,
      () => clock().getTime(),
    );
    // Provider refreshes are never retried automatically. Do not overwrite a
    // reseeded account or credentials another request has already rotated.
    const changed = await rows(
      db,
      `UPDATE withings_auth SET access_token = ?, refresh_token = ?,
      access_token_expires_at = ?, updated_at = ?
      WHERE id = 1 AND withings_user_id = ? AND refresh_token = ? AND access_token = ? RETURNING id`,
      tokens.accessToken,
      tokens.refreshToken,
      instant(tokens.expiresAt),
      now(),
      auth.withings_user_id,
      auth.refresh_token,
      auth.access_token,
    );
    if (!changed.length) {
      throw new WithingsError(
        "Withings credentials changed during refresh. The provider may already have rotated its token; check synchronization before retrying.",
      );
    }
    return tokens.accessToken;
  }
  async function sync(
    range: MeasureRange,
    label: string,
    advanceWatermark: boolean,
    auth: AuthRow,
  ): Promise<SyncSummary> {
    const cfg = clientConfig();
    const token = await accessTokenFor(cfg, auth);
    const { updatetime, groups } = await getWeights(cfg, token, range);
    const { accepted, skipped } = selectWeights(groups);
    // Every reading's write batch asserts account ownership atomically. An
    // account reseed during provider I/O must never import the old account.
    const guarded: Database = {
      prepare: (sql) => db.prepare(sql),
      async batch<T>(statements: Statement[]) {
        const result = await db.batch<T>([
          statement(
            db,
            `INSERT INTO api_write_assertions (id, rows_match)
            VALUES (1, EXISTS (SELECT 1 FROM withings_auth WHERE id = 1 AND withings_user_id = ?))`,
            auth.withings_user_id,
          ),
          ...statements,
          statement(db, "DELETE FROM api_write_assertions WHERE id = 1"),
        ]);
        return result.slice(1, -1);
      },
    };
    const weights = bodyweightStore(guarded, clock);
    let written = 0,
      duplicate = 0,
      refused = 0;
    for (const reading of accepted) {
      try {
        const { created } = await weights.recordBodyweight({
          ...reading,
          source: WITHINGS_SOURCE,
        });
        if (created) written++;
        else duplicate++;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        refused++;
        console.error(`withings: reading refused (status ${error.status})`);
      }
    }
    if ((await readAuth())?.withings_user_id !== auth.withings_user_id) {
      throw new WithingsError(
        "The Withings account changed during synchronization. The checkpoint is unchanged.",
      );
    }
    if (advanceWatermark) {
      // Only a complete lastupdate pass advances the provider-clock watermark.
      // A slower concurrent pass must not move an already newer mark backwards.
      const watermark = instant(new Date(updatetime * 1000).toISOString());
      const changed = await rows(
        db,
        `UPDATE withings_auth SET
        last_sync_at = CASE WHEN last_sync_at IS NULL OR last_sync_at < ? THEN ? ELSE last_sync_at END,
        updated_at = ? WHERE id = 1 AND withings_user_id = ? RETURNING id`,
        watermark,
        watermark,
        now(),
        auth.withings_user_id,
      );
      if (!changed.length) {
        throw new WithingsError(
          "The Withings account changed during synchronization. The checkpoint is unchanged.",
        );
      }
    }
    return {
      range: label,
      fetched: groups.length,
      ignored: skipped.length,
      written,
      duplicate,
      refused,
    };
  }
  async function requireAuth(expectedUserId?: string): Promise<AuthRow> {
    const auth = await readAuth();
    if (!auth) {
      throw new WithingsError(
        "No row in withings_auth, so there is no refresh token to authenticate with. Seed the Withings credentials before synchronizing.",
      );
    }
    if (
      expectedUserId !== undefined &&
      auth.withings_user_id !== expectedUserId
    ) {
      throw new WithingsError(
        "The notification does not belong to the configured Withings account.",
      );
    }
    return auth;
  }
  async function syncNotifiedWindow(
    startdate: number,
    enddate: number,
    expectedUserId?: string,
  ): Promise<SyncSummary> {
    return await sync(
      {
        startdate: startdate - NOTIFY_WINDOW_MARGIN_S,
        enddate: enddate + NOTIFY_WINDOW_MARGIN_S,
      },
      `window ${startdate}–${enddate}`,
      false,
      await requireAuth(expectedUserId),
    );
  }
  async function catchUp(
    override?: number,
    expectedUserId?: string,
  ): Promise<SyncSummary> {
    const auth = await requireAuth(expectedUserId);
    const since = override ??
      (auth.last_sync_at
        ? Math.floor(new Date(auth.last_sync_at).getTime() / 1000)
        : 0);
    return await sync({ lastupdate: since }, `since ${since}`, true, auth);
  }
  async function catchUpIfDue(): Promise<
    SyncSummary | { error: string } | null
  > {
    try {
      const at = clock();
      const claimed = await rows<{ withings_user_id: string }>(
        db,
        `UPDATE withings_auth
        SET last_sync_attempt_at = ?, updated_at = ? WHERE id = 1
        AND (last_sync_attempt_at IS NULL OR last_sync_attempt_at < ?) RETURNING withings_user_id`,
        instant(at.toISOString()),
        instant(at.toISOString()),
        instant(new Date(at.getTime() - CATCH_UP_INTERVAL_MS).toISOString()),
      );
      if (!claimed.length) return null;
      return await catchUp(undefined, claimed[0].withings_user_id);
    } catch {
      // Scheduled work never exposes provider text or database parameters.
      const error =
        "Withings catch-up failed; provider/error details withheld.";
      console.error(error);
      return { error };
    }
  }
  async function configuredUserId(): Promise<string | null> {
    return (await readAuth())?.withings_user_id ?? null;
  }
  /** Pass (promise) => ctx.waitUntil(promise), from fetch or scheduled. */
  function startCatchUp(waitUntil: (promise: Promise<unknown>) => void): void {
    waitUntil(catchUpIfDue());
  }
  return {
    syncNotifiedWindow,
    catchUp,
    catchUpIfDue,
    configuredUserId,
    startCatchUp,
  };
}
export type WithingsStore = ReturnType<typeof withingsStore>;
