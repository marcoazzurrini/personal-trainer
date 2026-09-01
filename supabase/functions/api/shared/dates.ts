// The calendar arithmetic, defined once.
//
// Every day in this system is a Rome calendar date carried as a bare
// "YYYY-MM-DD" string; which day "today" is gets decided by Postgres
// (`now() at time zone 'Europe/Rome'`, asked in calendar.ts and
// nowhere else), never here. What this module does is
// walk from one such day to another, and that walking is UTC-anchored on
// purpose: anchored to local time it would gain or lose a day in the DST
// weeks depending on the machine's zone data. tests/dates_test.ts holds
// mondayOf to the same answer as Postgres's date_trunc('week', …) so the two
// implementations of the week cannot drift apart.
//
// The future checks live here too: whether a day has happened yet is a
// question about the calendar, not about a field.

import { ApiError } from "../http/errors.ts";

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Monday of the week holding `day` — weeks run Monday to Sunday. */
export function mondayOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // Sun=0 … Sat=6
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}

/** The Sunday that ended the most recent week finished before `day`. */
export function lastFinishedSunday(day: string): string {
  return addDays(mondayOf(day), -1);
}

// Records describe what has already happened, so a future date is always a
// typo — and the ones that matter are silent. latestBodyfat() and the head of
// the trend series are both "the most recent row", so a year fat-fingered into
// 2027 becomes the body composition and the bodyweight that every calorie and
// protein target is computed from, and stays that way until someone notices.
// Both are read through `order by ... desc limit 1`, which no amount of later
// correct data can outrank.
//
// Callers pass Rome's today, read from Postgres — the API's calendar is
// Europe/Rome everywhere, and a UTC clock is already tomorrow at 23:30 Rome.
export function requireNotFuture(
  day: string,
  today: string,
  field: string,
): string {
  if (day > today) { // ISO dates sort lexicographically
    throw new ApiError(
      422,
      `"${field}" is ${day}, which is in the future — today is ${today} in Europe/Rome. A logged day records what was already eaten, weighed or measured. Check the year first: a slipped year is the usual cause and the hardest to spot afterwards.`,
    );
  }
  return day;
}

// The same rule for an instant rather than a calendar day. A few minutes of
// tolerance because a phone clock running slightly fast is not a typo; a
// slipped year, month or day is far outside it.
const CLOCK_SKEW_MS = 5 * 60_000;

export function requireNotFutureInstant(
  iso: string,
  field: string,
): string {
  if (Date.parse(iso) > Date.now() + CLOCK_SKEW_MS) {
    throw new ApiError(
      422,
      `"${field}" is ${iso}, which is in the future. A measurement records something that has already been taken. Check the year first: a slipped year is the usual cause and the hardest to spot afterwards.`,
    );
  }
  return iso;
}
