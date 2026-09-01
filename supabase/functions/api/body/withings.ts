// Wiring the Withings client to the database: where the credentials live, when
// they are refreshed, and what happens to a reading between arriving and
// becoming a row.
//
// Split from withings_client.ts so that file can stay import-free and testable
// against a stub. What is here is the part that needs a database.

import { sql } from "../db.ts";
import { recordBodyweight } from "./bodyweight.ts";
import { ApiError } from "../shared/errors.ts";
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

// Overridable the way GITHUB_API_BASE is: production never sets it, and the
// sync tests point it at a local stub so this file's wiring — watermark,
// refresh, refusal counting — can be exercised without touching Withings.
const API_BASE = Deno.env.get("WITHINGS_API_BASE") ??
  "https://wbsapi.withings.net";

// Refresh a minute early rather than on the tick: a token that expires between
// the check and the call would surface as a status 401 in the middle of a sync,
// and the retry would not come until the next catch-up.
const EXPIRY_MARGIN_MS = 60_000;

// How stale the last attempt must be before the /health ping does a catch-up.
// UptimeRobot hits /health every few minutes; without a throttle that would be
// a Withings call every few minutes, all but one of them returning nothing.
const CATCH_UP_INTERVAL_HOURS = 6;

interface AuthRow {
  withings_user_id: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: Date;
  last_sync_at: Date | null;
}

export interface SyncSummary {
  range: string;
  fetched: number;
  written: number;
  /** Already present and identical — a redelivery, which is free. */
  duplicate: number;
  /** Not a weight measurement: an objective, or a group without one. */
  ignored: number;
  /** Rejected by the bodyweight guards. Never fatal; see writeReadings. */
  refused: number;
}

function config(): WithingsConfig {
  const clientId = Deno.env.get("WITHINGS_CLIENT_ID");
  const clientSecret = Deno.env.get("WITHINGS_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new WithingsError(
      "WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are not set on the server, so no call to Withings can be authenticated.",
    );
  }
  return { apiBase: API_BASE, clientId, clientSecret };
}

async function readAuth(): Promise<AuthRow | null> {
  const [row] = await sql<AuthRow[]>`
    select withings_user_id, access_token, refresh_token,
           access_token_expires_at, last_sync_at
    from withings_auth where id = 1`;
  return row ?? null;
}

/**
 * A live access token, refreshing first if the stored one is spent.
 *
 * The write persists everything the refresh returned in one statement, before
 * the token is used for anything.
 *
 * Two syncs racing here both refresh, and the second is refused: Withings
 * answers status 601, "Same arguments in less than 10 seconds", to a repeated
 * refresh — observed while testing this, not inferred. The loser's sync fails,
 * is logged, and is redone by the next catch-up, which is the right outcome and
 * needs no lock. A lock would be the wrong shape anyway: the contended resource
 * is at Withings, not in this database.
 */
async function accessTokenFor(
  cfg: WithingsConfig,
  auth: AuthRow,
): Promise<string> {
  if (auth.access_token_expires_at.getTime() - Date.now() > EXPIRY_MARGIN_MS) {
    return auth.access_token;
  }
  const tokens = await refreshTokens(cfg, auth.refresh_token);
  await sql`
    update withings_auth
    set access_token = ${tokens.accessToken},
        refresh_token = ${tokens.refreshToken},
        access_token_expires_at = ${tokens.expiresAt},
        updated_at = now()
    where id = 1`;
  return tokens.accessToken;
}

/**
 * Writes the accepted readings, and refuses to let one bad one stop the rest.
 *
 * The 409 case is the one that matters. bodyweight rejects a second, different
 * value for an instant already recorded, on the principle that a measurement is
 * a fact — the right rule for a human correcting a typo. But the catch-up pass
 * asks Withings for everything *modified* since the watermark, so editing a
 * weigh-in in the Withings app delivers exactly that shape. Letting it throw
 * would abort the pass and, worse, leave the watermark unmoved so the same
 * conflict recurred every six hours forever. It is counted and logged instead.
 */
async function writeReadings(
  readings: { measuredAt: string; valueKg: number }[],
): Promise<{ written: number; duplicate: number; refused: number }> {
  let written = 0, duplicate = 0, refused = 0;
  for (const reading of readings) {
    try {
      const { created } = await recordBodyweight({
        valueKg: reading.valueKg,
        measuredAt: reading.measuredAt,
        source: WITHINGS_SOURCE,
      });
      if (created) written++;
      else duplicate++;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      refused++;
      console.error(
        `withings: refused ${reading.valueKg} kg at ${reading.measuredAt}: ${err.message}`,
      );
    }
  }
  return { written, duplicate, refused };
}

async function sync(
  range: MeasureRange,
  label: string,
  advanceWatermark: boolean,
): Promise<SyncSummary> {
  const auth = await readAuth();
  if (!auth) {
    throw new WithingsError(
      "No row in withings_auth, so there is no refresh token to authenticate with. Seed it with scripts/seed_withings.ts.",
    );
  }
  const cfg = config();
  const token = await accessTokenFor(cfg, auth);
  const { updatetime, groups } = await getWeights(cfg, token, range);
  const { accepted, skipped } = selectWeights(groups);

  for (const s of skipped) {
    console.log(`withings: ignored group ${s.grpid} — ${s.why}`);
  }

  const counts = await writeReadings(accepted);

  // The watermark means one specific thing: everything up to this instant has
  // been asked for by lastupdate. Only a lastupdate pass can establish that, so
  // only a lastupdate pass moves it.
  //
  // A notification's window sync must not, even though it also succeeded and
  // also has a fresh updatetime to hand. It asked about ninety seconds around
  // one weigh-in and learned nothing about anything else — so advancing the
  // watermark to now would declare a stretch of time examined that was never
  // examined, and any reading that changed inside it would fall behind the mark
  // and never be fetched again. The notification path would then be quietly
  // sawing off the branch the catch-up sits on: the busier the scale, the more
  // often the watermark jumps forward on evidence that does not support it.
  //
  // Only after the writes, and only from Withings' own clock: ours would open a
  // gap the width of the clock difference.
  if (advanceWatermark) {
    await sql`
      update withings_auth
      set last_sync_at = to_timestamp(${updatetime}), updated_at = now()
      where id = 1`;
  }

  return {
    range: label,
    fetched: groups.length,
    ignored: skipped.length,
    ...counts,
  };
}

/** The window a notification points at, widened at both ends. */
export function syncNotifiedWindow(
  startdate: number,
  enddate: number,
): Promise<SyncSummary> {
  return sync(
    {
      startdate: startdate - NOTIFY_WINDOW_MARGIN_S,
      enddate: enddate + NOTIFY_WINDOW_MARGIN_S,
    },
    `window ${startdate}–${enddate}`,
    false,
  );
}

/**
 * Everything created or modified since the watermark.
 *
 * lastupdate rather than a date window because that is what it is for: it
 * catches a reading whose notification was dropped, which a window keyed to a
 * notification we never received could not. A null watermark means this has
 * never run, and 0 asks for the whole history — which is correct, and is how
 * the first pass after seeding backfills.
 */
export async function catchUp(override?: number): Promise<SyncSummary> {
  const auth = await readAuth();
  const since = override ??
    (auth?.last_sync_at ? Math.floor(auth.last_sync_at.getTime() / 1000) : 0);
  return await sync({ lastupdate: since }, `since ${since}`, true);
}

/**
 * The catch-up as the /health ping sees it: throttled, and incapable of
 * failing loudly.
 *
 * /health exists so an uptime monitor can keep the free project from being
 * paused, and the monitor's ping is the only scheduled event this system has.
 * Riding the catch-up on it means no second scheduler to configure and forget.
 * Two rules make that safe. The claim below is a single conditional UPDATE, so
 * two pings arriving together cannot both take it. And every failure is
 * swallowed: Withings being down must never make the monitor believe the
 * project is down, which would turn an unavailable scale into a false alarm at
 * three in the morning.
 */
export async function catchUpIfDue(): Promise<
  SyncSummary | { error: string } | null
> {
  try {
    const [claimed] = await sql`
      update withings_auth
      set last_sync_attempt_at = now(), updated_at = now()
      where id = 1
        and (last_sync_attempt_at is null
             or last_sync_attempt_at
                < now() - make_interval(hours => ${CATCH_UP_INTERVAL_HOURS}))
      returning id`;
    if (!claimed) return null;
    return await catchUp();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`withings: catch-up failed — ${message}`);
    return { error: message };
  }
}

/** The user id the notification must claim, or null when unconfigured. */
export async function configuredUserId(): Promise<string | null> {
  const auth = await readAuth();
  return auth?.withings_user_id ?? null;
}
