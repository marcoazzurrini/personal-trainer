import type {
  WithingsAuth,
  WithingsRepository,
} from "../../db/repositories/withings.ts";
import { ApiError, databaseError } from "../shared/errors.ts";
import { instant, systemClock } from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import type { BodyweightService } from "./bodyweight.ts";
import {
  getWeights,
  NOTIFY_WINDOW_MARGIN_S,
  refreshTokens,
  selectWeights,
  WithingsError,
} from "./withings_client.ts";
import type { MeasureRange, WithingsConfig } from "./withings_client.ts";

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
/** Request-bound workflow. The caller owns all work through await or waitUntil. */
export function withingsStore(
  repository: WithingsRepository,
  weightsForAccount: (accountId: string) => BodyweightService,
  config: WithingsStoreConfig,
  clock: Clock = systemClock
) {
  const now = () => instant(clock().toISOString());
  function clientConfig(): WithingsConfig {
    if (!config.clientId || !config.clientSecret) {
      throw new WithingsError(
        "WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are not set on the server, so no call to Withings can be authenticated."
      );
    }
    return {
      apiBase: config.apiBase ?? "https://wbsapi.withings.net",
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    };
  }
  async function readAuth(): Promise<WithingsAuth | null> {
    try {
      return await repository.readAuth();
    } catch (error) {
      throw databaseError(error);
    }
  }
  async function accessTokenFor(
    cfg: WithingsConfig,
    auth: WithingsAuth
  ): Promise<string> {
    if (
      new Date(auth.access_token_expires_at).getTime() - clock().getTime() >
      EXPIRY_MARGIN_MS
    ) {
      return auth.access_token;
    }
    const tokens = await refreshTokens(cfg, auth.refresh_token, () =>
      clock().getTime()
    );
    // Provider refreshes are never retried automatically. Do not overwrite a
    // reseeded account or credentials another request has already rotated.
    let changed: boolean;
    try {
      changed = await repository.rotateCredentials(auth, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: instant(tokens.expiresAt),
        updatedAt: now(),
      });
    } catch (error) {
      throw databaseError(error);
    }
    if (!changed) {
      throw new WithingsError(
        "Withings credentials changed during refresh. The provider may already have rotated its token; check synchronization before retrying."
      );
    }
    return tokens.accessToken;
  }
  async function sync(
    range: MeasureRange,
    label: string,
    advanceWatermark: boolean,
    auth: WithingsAuth
  ): Promise<SyncSummary> {
    const cfg = clientConfig();
    const token = await accessTokenFor(cfg, auth);
    const { updatetime, groups } = await getWeights(cfg, token, range);
    const { accepted, skipped } = selectWeights(groups);
    // Every reading's write batch asserts account ownership atomically. An
    // account reseed during provider I/O must never import the old account.
    const weights = weightsForAccount(auth.withings_user_id);
    let duplicate = 0;
    let refused = 0;
    let written = 0;
    for (const reading of accepted) {
      try {
        const { created } = await weights.recordBodyweight({
          ...reading,
          source: WITHINGS_SOURCE,
        });
        if (created) {
          written += 1;
        } else {
          duplicate += 1;
        }
      } catch (error) {
        if (!(error instanceof ApiError)) {
          throw error;
        }
        refused += 1;
        console.error(`withings: reading refused (status ${error.status})`);
      }
    }
    if ((await readAuth())?.withings_user_id !== auth.withings_user_id) {
      throw new WithingsError(
        "The Withings account changed during synchronization. The checkpoint is unchanged."
      );
    }
    if (advanceWatermark) {
      // Only a complete lastupdate pass advances the provider-clock watermark.
      // A slower concurrent pass must not move an already newer mark backwards.
      const watermark = instant(new Date(updatetime * 1000).toISOString());
      let changed: boolean;
      try {
        changed = await repository.advanceWatermark(
          auth.withings_user_id,
          watermark,
          now()
        );
      } catch (error) {
        throw databaseError(error);
      }
      if (!changed) {
        throw new WithingsError(
          "The Withings account changed during synchronization. The checkpoint is unchanged."
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
  async function requireAuth(expectedUserId?: string): Promise<WithingsAuth> {
    const auth = await readAuth();
    if (!auth) {
      throw new WithingsError(
        "No row in withings_auth, so there is no refresh token to authenticate with. Seed the Withings credentials before synchronizing."
      );
    }
    if (
      expectedUserId !== undefined &&
      auth.withings_user_id !== expectedUserId
    ) {
      throw new WithingsError(
        "The notification does not belong to the configured Withings account."
      );
    }
    return auth;
  }
  async function syncNotifiedWindow(
    startdate: number,
    enddate: number,
    expectedUserId?: string
  ): Promise<SyncSummary> {
    return await sync(
      {
        startdate: startdate - NOTIFY_WINDOW_MARGIN_S,
        enddate: enddate + NOTIFY_WINDOW_MARGIN_S,
      },
      `window ${startdate}–${enddate}`,
      false,
      await requireAuth(expectedUserId)
    );
  }
  async function catchUp(
    override?: number,
    expectedUserId?: string
  ): Promise<SyncSummary> {
    const auth = await requireAuth(expectedUserId);
    const since =
      override ??
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
      const claimed = await repository.claimCatchUp(
        instant(at.toISOString()),
        instant(new Date(at.getTime() - CATCH_UP_INTERVAL_MS).toISOString())
      );
      if (claimed === null) {
        return null;
      }
      return await catchUp(undefined, claimed);
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
