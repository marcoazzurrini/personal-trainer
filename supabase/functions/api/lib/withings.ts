// The Withings half of the bodyweight sync: refreshing the token, asking for
// measurements, and deciding which of them count as weigh-ins.
//
// Import-free on purpose, like lib/github.ts: no database, no clock beyond
// Date.now(), no edge-runtime types. Everything here can be exercised against a
// stub server in a plain `deno test`, which matters because the two ways this
// integration fails are both invisible in production — a token that quietly
// stops refreshing, and a filter that quietly lets the wrong numbers through.

export interface WithingsConfig {
  apiBase: string; // https://wbsapi.withings.net, or the stub in tests
  clientId: string;
  clientSecret: string;
}

// Routes translate this into a logged failure rather than an error response:
// a notification we could not service is not the notifier's problem.
export class WithingsError extends Error {}

/**
 * Every call to Withings goes through here, for one reason.
 *
 * Withings answers HTTP 200 to failures. An expired token, a revoked grant, a
 * malformed request — all of them arrive as a cheerful 200 whose body carries
 * `status: 401` or `status: 342`. Reading `res.ok` would turn each of those
 * into a success with an empty measurement list, which is indistinguishable
 * from "he did not weigh himself today". So the body's status field is the
 * result and the HTTP code is decoration; a missing status field is a failure
 * too, because it means this is not a Withings response at all.
 */
async function callWithings(
  cfg: WithingsConfig,
  path: string,
  params: Record<string, string>,
  accessToken?: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: new URLSearchParams(params),
  });

  const json = await res.json().catch(() => null) as
    | { status?: unknown; body?: unknown; error?: unknown }
    | null;

  if (json === null || typeof json.status !== "number") {
    throw new WithingsError(
      `Withings replied ${res.status} to ${path} with a body that is not a Withings response. Either the API base is wrong or something is answering in its place.`,
    );
  }
  if (json.status !== 0) {
    throw new WithingsError(
      `Withings refused ${path} with status ${json.status}${
        typeof json.error === "string" ? ` (${json.error})` : ""
      }. HTTP was ${res.status}; the status field is the one that means anything.`,
    );
  }
  return (json.body ?? {}) as Record<string, unknown>;
}

// --- Tokens ----------------------------------------------------------------

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
}

/**
 * Exchanges a refresh token for a live access token.
 *
 * The caller must persist all three returned fields, unconditionally, before
 * doing anything else with the token. Withings documents that the refresh token
 * rotates; on this account it has been observed to come back unchanged. Writing
 * back whatever arrived is correct under both behaviours, and it is the only
 * way to be correct under both — a caller that persists only when the value
 * differs is one Withings behaviour change away from an integration that works
 * for three hours and then stops without saying so.
 */
export async function refreshTokens(
  cfg: WithingsConfig,
  refreshToken: string,
): Promise<TokenSet> {
  const body = await callWithings(cfg, "/v2/oauth2", {
    action: "requesttoken",
    grant_type: "refresh_token",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
  }) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.expires_in !== "number"
  ) {
    throw new WithingsError(
      "Withings accepted the refresh but did not return an access token, a refresh token and an expiry. Refusing to persist a partial token set.",
    );
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  };
}

// --- Measurements ----------------------------------------------------------

export interface Measure {
  value: number;
  type: number;
  unit: number;
}

export interface MeasureGroup {
  grpid: number;
  date: number; // epoch seconds, UTC
  attrib: number;
  category: number;
  deviceid: string | null;
  measures: Measure[];
}

export interface MeasureResponse {
  /** Withings' own clock at the moment it answered — the next lastupdate. */
  updatetime: number;
  groups: MeasureGroup[];
}

/** A closed window (what a notification describes) or an open tail (catch-up). */
export type MeasureRange =
  | { startdate: number; enddate: number }
  | { lastupdate: number };

const MEASTYPE_WEIGHT = "1";
const CATEGORY_REAL = "1"; // as opposed to 2, a user's stated objective

export async function getWeights(
  cfg: WithingsConfig,
  accessToken: string,
  range: MeasureRange,
): Promise<MeasureResponse> {
  const window: Record<string, string> = "lastupdate" in range
    ? { lastupdate: String(range.lastupdate) }
    : {
      startdate: String(range.startdate),
      enddate: String(range.enddate),
    };

  const body = await callWithings(cfg, "/measure", {
    action: "getmeas",
    meastype: MEASTYPE_WEIGHT,
    category: CATEGORY_REAL,
    ...window,
  }, accessToken) as { updatetime?: number; measuregrps?: MeasureGroup[] };

  return {
    updatetime: typeof body.updatetime === "number"
      ? body.updatetime
      : Math.floor(Date.now() / 1000),
    groups: body.measuregrps ?? [],
  };
}

// --- What counts as a weigh-in ---------------------------------------------

export interface WeightReading {
  grpid: number;
  measuredAt: string; // ISO, UTC
  valueKg: number;
}

export interface Selection {
  accepted: WeightReading[];
  skipped: { grpid: number; why: string }[];
}

/**
 * Keeps the weight measurements and discards what is not one.
 *
 * This filter used to also pin the scale's device id, to keep hand-entered and
 * third-party-imported weights out. That clause is gone, and the reason it is
 * gone is worth more than the clause was.
 *
 * It could never be verified. The account was inspected before any of this was
 * written and held nothing but scale readings — no manual entry, no import — so
 * there was no negative example to test the rule against. It guarded a case that
 * had already been cleaned up and, on the evidence available, might never occur.
 *
 * Against that it carried a real failure: a replaced scale reports a different
 * device id, every reading would fail the pin, and the sync would stop writing
 * rows while continuing to report success. Nothing would raise an error. The
 * first sign would be a coach saying there is not enough data to estimate
 * expenditure, weeks later, for reasons no one would connect to a new scale.
 *
 * So the trade was an unverifiable guard against a silent, delayed, hard-to-
 * diagnose failure — and Withings' own account is now the source of truth: what
 * it holds as a real measurement is treated as one. The cost of that choice,
 * stated plainly: connect another app to Withings and its weights will flow in
 * here too.
 */
export function selectWeights(groups: readonly MeasureGroup[]): Selection {
  const accepted: WeightReading[] = [];
  const skipped: { grpid: number; why: string }[] = [];

  for (const group of groups) {
    if (group.category !== 1) {
      skipped.push({
        grpid: group.grpid,
        why: `category ${group.category} is an objective, not a measurement`,
      });
      continue;
    }
    const weight = group.measures?.find((m) => m.type === 1);
    if (!weight) {
      skipped.push({
        grpid: group.grpid,
        why: "no weight measure in the group",
      });
      continue;
    }
    accepted.push({
      grpid: group.grpid,
      measuredAt: new Date(group.date * 1000).toISOString(),
      valueKg: scaleToKg(weight),
    });
  }

  return { accepted, skipped };
}

/**
 * value × 10^unit. A 72.7 kg reading arrives as { value: 72700, unit: -3 }, and
 * the exponent is per-measure rather than fixed, so it is read rather than
 * assumed.
 *
 * Rounded to two decimals because bodyweight.value_kg is numeric(5, 2) and
 * would round anyway — but doing it here rather than leaving it to Postgres is
 * what keeps the write idempotent. The dedupe on retry compares the value being
 * written against the value already stored; hand Postgres 72.655 and it stores
 * 72.66, and every later redelivery of that same reading would compare unequal
 * and be rejected as a conflicting measurement. Sending what will actually be
 * stored makes the second delivery a no-op, which is the entire reason two
 * delivery paths are safe.
 */
function scaleToKg(measure: Measure): number {
  const kg = measure.value * Math.pow(10, measure.unit);
  return Math.round(kg * 100) / 100;
}

/** The instant a notification's window starts, widened by a safety margin. */
export const NOTIFY_WINDOW_MARGIN_S = 60;
