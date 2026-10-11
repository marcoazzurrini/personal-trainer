import type {
  WithingsAuth,
  WithingsRepository,
} from "@trainer/db/repositories/withings.ts";
import { Config, Effect, Option } from "effect";

import { effectful } from "../shared/database.ts";
import { databaseRefusal } from "../shared/errors.ts";
import type { DatabaseFailure, Invalid } from "../shared/refusals.ts";
import type { Invocation } from "../shared/runtime.ts";
import { background } from "../shared/runtime.ts";
import { currentTime, instant, now } from "../shared/values.ts";
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

// Server configuration only, read from this invocation's bindings. Missing
// credentials fail when a sync is attempted, never before.
const settings = Config.all({
  apiBase: Config.String("WITHINGS_API_BASE").pipe(
    Config.withDefault("https://wbsapi.withings.net")
  ),
  clientId: Config.option(Config.String("WITHINGS_CLIENT_ID")),
  clientSecret: Config.option(Config.Redacted("WITHINGS_CLIENT_SECRET")),
});

export interface SyncSummary {
  range: string;
  fetched: number;
  written: number;
  duplicate: number;
  ignored: number;
  refused: number;
}

type SyncFailure = WithingsError | Invalid | DatabaseFailure;

/** Request-bound workflow. The caller owns all work through run or background. */
export function withingsStore(
  rows: WithingsRepository,
  weightsForAccount: (accountId: string) => BodyweightService
) {
  const repository = effectful(rows);

  const clientConfig = Effect.fn("withings.clientConfig")(
    function* (): Effect.fn.Return<WithingsConfig, WithingsError> {
      // A binding of the wrong type is a deployment bug, not a refusal.
      const config = yield* settings.pipe(Effect.orDie);
      if (
        Option.isNone(config.clientId) ||
        Option.isNone(config.clientSecret)
      ) {
        return yield* new WithingsError({
          message:
            "WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are not set on the server, so no call to Withings can be authenticated.",
        });
      }
      return {
        apiBase: config.apiBase,
        clientId: config.clientId.value,
        clientSecret: config.clientSecret.value,
      };
    }
  );

  const accessTokenFor = Effect.fn("withings.accessTokenFor")(function* (
    cfg: WithingsConfig,
    auth: WithingsAuth
  ): Effect.fn.Return<string, SyncFailure> {
    const at = yield* currentTime;
    if (
      new Date(auth.access_token_expires_at).getTime() - at.getTime() >
      EXPIRY_MARGIN_MS
    ) {
      return auth.access_token;
    }
    // Provider refreshes are never retried automatically: the refresh below
    // runs once, and so does the write after it. Do not overwrite a reseeded
    // account or credentials another request has already rotated.
    const tokens = yield* refreshTokens(cfg, auth.refresh_token);
    const changed = yield* repository.rotateCredentials(auth, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: yield* instant(tokens.expiresAt),
      updatedAt: yield* now,
    });
    if (!changed) {
      return yield* new WithingsError({
        message:
          "Withings credentials changed during refresh. The provider may already have rotated its token; check synchronization before retrying.",
      });
    }
    return tokens.accessToken;
  });

  const sync = Effect.fn("withings.sync")(function* (
    range: MeasureRange,
    label: string,
    advanceWatermark: boolean,
    auth: WithingsAuth
  ): Effect.fn.Return<SyncSummary, SyncFailure> {
    const cfg = yield* clientConfig();
    const token = yield* accessTokenFor(cfg, auth);
    const { updatetime, groups } = yield* getWeights(cfg, token, range);
    const { accepted, skipped } = selectWeights(groups);
    // Every reading's write batch asserts account ownership atomically. An
    // account reseed during provider I/O must never import the old account.
    const weights = weightsForAccount(auth.withings_user_id);
    let duplicate = 0;
    let refused = 0;
    let written = 0;
    for (const reading of accepted) {
      // A refusal is counted and the pass goes on; a defect aborts it.
      const outcome = yield* weights
        .recordBodyweight({ ...reading, source: WITHINGS_SOURCE })
        .pipe(
          Effect.map(({ created }) => (created ? "written" : "duplicate")),
          Effect.catch((error) =>
            Effect.logError(
              `withings: reading refused (status ${
                error._tag === "DatabaseFailure"
                  ? databaseRefusal(error).status
                  : error.status
              })`
            ).pipe(Effect.as("refused" as const))
          )
        );
      if (outcome === "written") {
        written += 1;
      } else if (outcome === "duplicate") {
        duplicate += 1;
      } else {
        refused += 1;
      }
    }
    if (
      (yield* repository.readAuth())?.withings_user_id !== auth.withings_user_id
    ) {
      return yield* new WithingsError({
        message:
          "The Withings account changed during synchronization. The checkpoint is unchanged.",
      });
    }
    if (advanceWatermark) {
      // Only a complete lastupdate pass advances the provider-clock watermark.
      // A slower concurrent pass must not move an already newer mark backwards.
      const watermark = yield* instant(
        new Date(updatetime * 1000).toISOString()
      );
      const changed = yield* repository.advanceWatermark(
        auth.withings_user_id,
        watermark,
        yield* now
      );
      if (!changed) {
        return yield* new WithingsError({
          message:
            "The Withings account changed during synchronization. The checkpoint is unchanged.",
        });
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
  });

  const requireAuth = Effect.fn("withings.requireAuth")(function* (
    expectedUserId?: string
  ): Effect.fn.Return<WithingsAuth, WithingsError | DatabaseFailure> {
    const auth = yield* repository.readAuth();
    if (!auth) {
      return yield* new WithingsError({
        message:
          "No row in withings_auth, so there is no refresh token to authenticate with. Seed the Withings credentials before synchronizing.",
      });
    }
    if (
      expectedUserId !== undefined &&
      auth.withings_user_id !== expectedUserId
    ) {
      return yield* new WithingsError({
        message:
          "The notification does not belong to the configured Withings account.",
      });
    }
    return auth;
  });

  const syncNotifiedWindow = Effect.fn("withings.syncNotifiedWindow")(
    function* (
      startdate: number,
      enddate: number,
      expectedUserId?: string
    ): Effect.fn.Return<SyncSummary, SyncFailure> {
      const auth = yield* requireAuth(expectedUserId);
      return yield* sync(
        {
          startdate: startdate - NOTIFY_WINDOW_MARGIN_S,
          enddate: enddate + NOTIFY_WINDOW_MARGIN_S,
        },
        `window ${startdate}–${enddate}`,
        false,
        auth
      );
    }
  );

  const catchUp = Effect.fn("withings.catchUp")(function* (
    override?: number,
    expectedUserId?: string
  ): Effect.fn.Return<SyncSummary, SyncFailure> {
    const auth = yield* requireAuth(expectedUserId);
    const since =
      override ??
      (auth.last_sync_at
        ? Math.floor(new Date(auth.last_sync_at).getTime() / 1000)
        : 0);
    return yield* sync({ lastupdate: since }, `since ${since}`, true, auth);
  });

  const catchUpIfDue = Effect.fn("withings.catchUpIfDue")(
    function* (): Effect.fn.Return<
      SyncSummary | { error: string } | null,
      SyncFailure
    > {
      const at = yield* currentTime;
      const claimed = yield* repository.claimCatchUp(
        yield* instant(at.toISOString()),
        yield* instant(
          new Date(at.getTime() - CATCH_UP_INTERVAL_MS).toISOString()
        )
      );
      if (claimed === null) {
        return null;
      }
      return yield* catchUp(undefined, claimed);
    },
    // Whatever went wrong, failure or defect, scheduled work never exposes
    // provider text or database parameters.
    Effect.catchCause(() => {
      const error =
        "Withings catch-up failed; provider/error details withheld.";
      return Effect.logError(error).pipe(Effect.as({ error }));
    })
  );

  const configuredUserId = Effect.fn("withings.configuredUserId")(
    function* (): Effect.fn.Return<string | null, DatabaseFailure> {
      return (yield* repository.readAuth())?.withings_user_id ?? null;
    }
  );

  /** Hand the due catch-up to this invocation's waitUntil, from fetch or scheduled. */
  const startCatchUp = Effect.fn("withings.startCatchUp")(
    function* (): Effect.fn.Return<void, never, Invocation> {
      yield* background(catchUpIfDue().pipe(Effect.asVoid));
    }
  );

  return {
    syncNotifiedWindow,
    catchUp,
    catchUpIfDue,
    configuredUserId,
    startCatchUp,
  };
}
export type WithingsStore = ReturnType<typeof withingsStore>;
