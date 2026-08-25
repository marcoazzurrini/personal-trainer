// The calendar arithmetic, defined once.
//
// Every day in this system is a Rome calendar date carried as a bare
// "YYYY-MM-DD" string; which day "today" is gets decided by Postgres
// (`now() at time zone 'Europe/Rome'`), never here. What this module does is
// walk from one such day to another, and that walking is UTC-anchored on
// purpose: anchored to local time it would gain or lose a day in the DST
// weeks depending on the machine's zone data. tests/dates_test.ts holds
// mondayOf to the same answer as Postgres's date_trunc('week', …) so the two
// implementations of the week cannot drift apart.

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
