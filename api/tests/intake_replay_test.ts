import { assertEquals } from "@std/assert";
import postgres from "postgres";
import { api, DB_URL, resetNutrition, uuid } from "./helpers.ts";
import {
  assertIdentity,
  databaseIdentity,
  verifiedDatabase,
} from "./disposable.ts";

Deno.test("logIntake replays the stored meal day across Rome midnight", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const disposable = await verifiedDatabase();
  await resetNutrition();
  for (const name of ["Midnight A", "Midnight B"]) {
    assertEquals(
      (await api.post("/foods", {
        name,
        kcal_100g: 100,
        protein_100g: 25,
        carbs_100g: 0,
        fat_100g: 0,
        source: "label",
      })).status,
      201,
    );
  }
  assertEquals(
    (await api.post("/meals", {
      name: "Midnight meal",
      items: [{ food: "Midnight A", grams: 100 }, {
        food: "Midnight B",
        grams: 50,
      }],
    })).status,
    201,
  );

  // Only this test's verified singleton sees this SQL clock. The HTTP API and
  // machine clocks are untouched; real calendar SQL still converts to Rome.
  const db = postgres(DB_URL);
  const { sql } = await import("../db.ts");
  const previous = sql.options.connection.search_path;
  try {
    await db`create schema intake_replay_clock`;
    await db`create table intake_replay_clock.instant (at timestamptz not null)`;
    await db`insert into intake_replay_clock.instant values ('2026-01-01T22:59:59Z')`;
    await db`create function intake_replay_clock.now() returns timestamptz language sql stable
      as 'select at from intake_replay_clock.instant'`;
    sql.options.connection.search_path =
      "intake_replay_clock,pg_catalog,public";
    assertIdentity(disposable, await databaseIdentity(sql));
    const { logIntake } = await import("../nutrition/intake.ts");
    const { romeToday } = await import("../shared/calendar.ts");
    assertEquals(await romeToday(), "2026-01-01");
    const request_id = uuid();
    const first = await logIntake({ meal: "Midnight meal", request_id });
    assertEquals(first.created, true);
    assertEquals(first.view.day, "2026-01-01");
    assertEquals(first.view.entries.length, 2);
    await db`update intake_replay_clock.instant set at = '2026-01-01T23:00:01Z'`;
    assertEquals(await romeToday(), "2026-01-02");
    const retry = await logIntake({ meal: "Midnight meal", request_id });
    assertEquals(retry, { created: false, view: first.view });
    for (const day of ["2026-01-02", "2099-01-01"]) {
      const changed = await api.post("/intake", {
        day,
        meal: "Midnight meal",
        request_id,
      });
      assertEquals(changed.status, 200);
      assertEquals(changed.body, JSON.parse(JSON.stringify(first.view)));
    }
    assertEquals((await api.get("/intake?day=2026-01-02")).body.entries, []);
    assertEquals(
      (await db`select count(*)::int as n from intake_entries`)[0].n,
      2,
    );
  } finally {
    sql.options.connection.search_path = previous;
    await sql.end();
    await db`drop schema if exists intake_replay_clock cascade`;
    await db.end();
  }
});
