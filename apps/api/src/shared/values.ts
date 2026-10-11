import {
  canonicalDate,
  canonicalInstant,
  canonicalUuid,
  romeDate as canonicalRomeDate,
  scaledInteger,
} from "@trainer/db/storage.ts";
import { Clock, Effect } from "effect";

import { Invalid } from "./refusals.ts";

export function decimal(
  value: number,
  precision: number,
  scale: number
): Effect.Effect<number, Invalid>;
export function decimal(
  value: number | null,
  precision: number,
  scale: number
): Effect.Effect<number | null, Invalid>;
export function decimal(
  value: number | null,
  precision: number,
  scale: number
): Effect.Effect<number | null, Invalid> {
  if (value === null) {
    return Effect.succeed(null);
  }
  return Effect.try({
    try: () => scaledInteger(value, precision, scale),
    catch: () =>
      new Invalid({
        message:
          "A number is too large or is not finite. Check for a misplaced decimal point, or per-serving values sent as per-100 g.",
      }),
  });
}

/** Accept the API's offset-bearing instants without losing microseconds. */
export function instant(value: string): Effect.Effect<string, Invalid> {
  const match =
    /^(?<wallClock>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,6}))?(?<offset>Z|[+-]\d{2}:\d{2})$/u.exec(
      value
    );
  if (!match) {
    return Effect.fail(
      new Invalid({
        message:
          "Send a real timestamp with a timezone and no more than six fractional digits.",
      })
    );
  }
  return Effect.try({
    try: () => {
      // Validate the wall-clock calendar before Date can normalize an impossible
      // day. Then convert the offset with Date and restore all fractional digits.
      canonicalInstant(`${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`);
      const parsed = new Date(value);
      if (
        match[1].startsWith("0000") ||
        parsed.toISOString().startsWith("0000")
      ) {
        throw new Error("Unsupported year.");
      }
      return canonicalInstant(
        `${parsed.toISOString().slice(0, 19)}.${(match[2] ?? "").padEnd(6, "0")}Z`
      );
    },
    catch: () =>
      new Invalid({
        message: "Send a real timestamp with a timezone, in years 0001–9999.",
      }),
  });
}

// Match the PostgreSQL driver's Date JSON representation at the wire boundary,
// not in storage or validation snapshots: omitted microseconds stay untouched.
export function wireInstant(value: string): string;
export function wireInstant(value: string | null): string | null;
export function wireInstant(value: string | null): string | null {
  return value === null ? null : `${value.slice(0, 23)}Z`;
}

export function date(value: string): Effect.Effect<string, Invalid> {
  return Effect.try({
    try: () => {
      if (value.slice(0, 4) === "0000") {
        throw new Error("Unsupported year.");
      }
      return canonicalDate(value);
    },
    catch: () =>
      new Invalid({
        message: "Send a real YYYY-MM-DD calendar date in years 0001–9999.",
      }),
  });
}

export function requestId(value: string): Effect.Effect<string, Invalid> {
  return Effect.try({
    try: () => canonicalUuid(value),
    catch: () =>
      new Invalid({
        message:
          "request_id must be a UUID. Reuse it only when retrying the same operation.",
      }),
  });
}

// Runtime callers also supply Date.toISOString() values. The transfer codec
// deliberately accepts only canonical export instants, so normalize here.
export function romeDate(value: string): Effect.Effect<string, Invalid> {
  return instant(value).pipe(Effect.map(canonicalRomeDate));
}

export { caseKey } from "@trainer/db/storage.ts";

// ------------------------------------------------------------------- time
//
// Time comes from the Effect Clock of the running request, never from Date
// directly: the composition root decides what "now" is, and a test sets it
// there instead of threading a clock through every store.

/** The current wall time. */
export const currentTime: Effect.Effect<Date> = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => new Date(millis))
);

/** The current instant, canonical as stored. A clock outside 0001–9999 is a defect. */
export const now: Effect.Effect<string> = currentTime.pipe(
  Effect.flatMap((at) => instant(at.toISOString())),
  Effect.orDie
);

/** Today's calendar date in Europe/Rome. */
export const today: Effect.Effect<string> = now.pipe(
  Effect.map(canonicalRomeDate)
);

/**
 * A clock whose wall time comes from `wallTime`. Span timing and sleeps stay on
 * the system clock, so timeouts are real even when the wall time is fixed, and
 * tracing never counts as a read of the injected time.
 */
export function clockFrom(wallTime: () => Date): Clock.Clock {
  const system = Clock.Clock.defaultValue();
  return {
    currentTimeMillisUnsafe: () => wallTime().getTime(),
    currentTimeMillis: Effect.sync(() => wallTime().getTime()),
    currentTimeNanosUnsafe: () => system.currentTimeNanosUnsafe(),
    currentTimeNanos: system.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => system.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: system.monotonicTimeNanos,
    sleep: (duration) => system.sleep(duration),
  };
}

/** A clock stopped at one instant. */
export function fixedClock(at: Date | number | string): Clock.Clock {
  const stopped = new Date(at);
  return clockFrom(() => new Date(stopped));
}

/**
 * Run `effect` with the wall time read once, so every nested read sees the
 * same instant — including across Rome midnight.
 */
export function atOneInstant<A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((millis) =>
      Effect.provideService(effect, Clock.Clock, fixedClock(millis))
    )
  );
}
