import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import postgres from "postgres";
import {
  addDays,
  daysBetween,
  lastFinishedSunday,
  mondayOf,
} from "../supabase/functions/api/lib/dates.ts";

// lib/dates.ts is one of two implementations of the calendar — the other is
// Postgres's date_trunc, which the routes use in SQL. helpers.ts once carried
// a third, and its own comments explained why two clocks that must agree
// eventually will not. Now there are exactly two, and this file pins them to
// each other; the pure laws above the pin are what make the arithmetic safe
// across the DST weeks the generators deliberately straddle.

const isoDay = fc.integer({ min: 10_000, max: 40_000 }) // 1997–2079
  .map((n) => new Date(n * 86_400_000).toISOString().slice(0, 10));

Deno.test("walking the calendar and measuring it agree", () => {
  // The round trip daysBetween(d, addDays(d, n)) === n is exactly what local
  // anchoring would break twice a year: a DST-crossing walk would come back
  // 23 or 25 hours long and the rounding would hide it until it didn't.
  fc.assert(
    fc.property(isoDay, fc.integer({ min: -1000, max: 1000 }), (d, n) => {
      assertEquals(daysBetween(d, addDays(d, n)), n);
    }),
  );
  fc.assert(
    fc.property(
      isoDay,
      fc.integer({ min: -500, max: 500 }),
      fc.integer({ min: -500, max: 500 }),
      (d, a, b) => {
        assertEquals(addDays(addDays(d, a), b), addDays(d, a + b));
      },
    ),
  );
});

Deno.test("mondayOf lands on a Monday, at most six days back", () => {
  fc.assert(fc.property(isoDay, (d) => {
    const monday = mondayOf(d);
    assertEquals(new Date(`${monday}T00:00:00Z`).getUTCDay(), 1);
    const back = daysBetween(monday, d);
    assert(back >= 0 && back <= 6, `${monday} is ${back} days before ${d}`);
    assertEquals(mondayOf(monday), monday); // idempotent
    assertEquals(lastFinishedSunday(d), addDays(monday, -1));
  }));
});

Deno.test("the JS week and the SQL week are the same week", async () => {
  // The routes ask Postgres date_trunc('week', …); the tests and the pure
  // code ask mondayOf. Every DST month for three years plus a sweep across
  // eight decades, answered by both, compared day by day.
  const days: string[] = [];
  for (const year of [2025, 2026, 2027]) {
    for (const month of ["03", "10"]) {
      for (let d = 1; d <= 31; d++) {
        const day = `${year}-${month}-${String(d).padStart(2, "0")}`;
        if (!Number.isNaN(Date.parse(day))) days.push(day);
      }
    }
  }
  for (let n = 10_000; n <= 40_000; n += 97) {
    days.push(new Date(n * 86_400_000).toISOString().slice(0, 10));
  }

  const db = postgres(
    Deno.env.get("TEST_DATABASE_URL") ??
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  );
  try {
    const rows = await db`
      select d::text as day, date_trunc('week', d)::date::text as monday
      from unnest(string_to_array(${days.join(",")}, ',')::date[]) as d`;
    assertEquals(rows.length, days.length);
    for (const row of rows) {
      assertEquals(
        mondayOf(row.day as string),
        row.monday as string,
        `disagree on ${row.day}`,
      );
    }
  } finally {
    await db.end();
  }
});
