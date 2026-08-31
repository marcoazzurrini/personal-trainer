import { sql } from "../db.ts";

// Which day it is, asked of Postgres — and the only place 'Europe/Rome' is
// named.
//
// rules/dates.ts is the other half of this: it walks from one day to another
// and may not import db.ts. Deciding *which* day is now is not arithmetic. It
// is a question whose answer changes, and it has to be answered by the same
// clock that stamped the rows, because a UTC process is already tomorrow at
// 23:30 Rome — a server answering from its own clock would file the evening's
// training under the wrong day for the last half hour of every night.
//
// Everything below composes from romeNow(), so the zone is written once here
// rather than copied into eight route files, where the next one to be pasted
// is the one that gets pasted wrong. Each is a function and not a shared
// constant: a postgres.js fragment is a query object rather than a string, so
// callers splice a fresh one instead of sharing an instance.

/** The current instant, as Rome reads it. */
export function romeNow() {
  return sql`now() at time zone 'Europe/Rome'`;
}

/** Today's Rome calendar date. */
export function romeDate() {
  return sql`(${romeNow()})::date`;
}

/** The Monday of the week holding today — weeks run Monday to Sunday. */
export function romeWeekStart() {
  return sql`date_trunc('week', ${romeNow()})::date`;
}

/** Today's ISO day of week: Monday is 1, Sunday is 7. */
export function romeIsoDow() {
  return sql`extract(isodow from ${romeNow()})::int`;
}

export async function romeToday(): Promise<string> {
  const [row] = await sql<{ today: string }[]>`
    select ${romeDate()} as today`;
  return row.today;
}

/** The Sunday that ended the most recent finished week. */
export async function lastFinishedDay(): Promise<string> {
  const [row] = await sql<{ day: string }[]>`
    select ${romeWeekStart()} - 1 as day`;
  return row.day;
}
