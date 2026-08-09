import { assert, assertEquals } from "@std/assert";
import { api, daysAgo, resetNutrition } from "./helpers.ts";

// The daily_bodyweight view, through the API that reads it.
//
// bodyweight stores instants; everything downstream needs one value per Rome
// calendar day. Two rules do that collapsing, both of them in SQL, both of
// them silent when wrong: which instant wins when a day has several, and which
// day an instant belongs to. Neither is observable from the bodyweight
// endpoint — it returns the raw series — so they are asserted through
// nutrition-state's recent_days, which reads the view.
//
// A break in either rule reads as a real weight change: the trend moves, the
// back-solve reads a slope that never happened, and the calorie target follows.

Deno.test("one weight per Rome day", async (t) => {
  await resetNutrition();

  const day = daysAgo(4);
  const weightOn = async (d: string) => {
    const { body } = await api.get("/nutrition-state");
    return body.recent_days.find((r: { day: string }) => r.day === d)
      ?.weight_kg ?? null;
  };

  await t.step("the earliest weigh-in of a day wins", async () => {
    // Not the latest, and not a mean. The morning weigh-in is the
    // standardized measurement — fasted, before drinking — and an evening
    // weight carries a day of food and water on top of it. Taking the later
    // one would add a couple of kilos of noise to every day it exists, which
    // is more than the signal the trend is trying to measure.
    await api.post("/bodyweight", {
      value_kg: 82.0,
      measured_at: `${day}T05:00:00Z`,
      source: "morning",
    });
    await api.post("/bodyweight", {
      value_kg: 84.0,
      measured_at: `${day}T19:00:00Z`,
      source: "evening",
    });

    assertEquals(await weightOn(day), 82.0);

    // Both rows survive — the view chooses, it does not discard.
    const series = await api.get("/bodyweight");
    assertEquals(series.body.bodyweight.length, 2);
  });

  await t.step(
    "an instant belongs to its Rome day, not its UTC day",
    async () => {
      // 23:30 UTC is already 01:30 the next morning in Rome, so this is a
      // weigh-in on the following day. Filing it under the UTC date would
      // shift a weigh-in back a day and, on the days either side of a gap,
      // change the slope the back-solve measures.
      const utcDay = daysAgo(3);
      const romeDay = daysAgo(2);
      await api.post("/bodyweight", {
        value_kg: 81.5,
        measured_at: `${utcDay}T23:30:00Z`,
        source: "late",
      });

      assertEquals(await weightOn(romeDay), 81.5);
      assertEquals(await weightOn(utcDay), null);
    },
  );

  await t.step(
    "two sources at the same instant: first recorded wins, every time",
    async () => {
      // The unique key is (measured_at, source), so the same instant from two
      // sources is two legal rows — and until the view's tiebreak reached the
      // id, which one seeded the day was the planner's whim. A nondeterministic
      // value at the bottom of the trend is a calorie target that changes
      // between reads of an unchanged record.
      const day = daysAgo(6);
      const instant = `${day}T05:45:00Z`;
      await api.post("/bodyweight", {
        value_kg: 80.0,
        measured_at: instant,
        source: "manual",
      });
      await api.post("/bodyweight", {
        value_kg: 90.0,
        measured_at: instant,
        source: "withings",
      });

      assertEquals(await weightOn(day), 80.0);

      // Both rows survive; the view chooses, deterministically.
      const series = await api.get("/bodyweight");
      const atInstant = series.body.bodyweight.filter(
        (r: { measured_at: string }) =>
          r.measured_at.startsWith(`${day}T05:45`),
      );
      assertEquals(atInstant.length, 2);
    },
  );

  await t.step("the trend reads the collapsed series", async () => {
    // The wiring assertion: loadTrend runs off daily_bodyweight, so the
    // earliest-wins choice above has to be what the EMA actually sees. An
    // 84.0 leaking through would show up here and nowhere else.
    const { body } = await api.get("/nutrition-state");
    assert(body.trend_weight !== null);
    assert(
      body.trend_weight.trend_kg < 83,
      `the evening 84.0 leaked into the trend: ${body.trend_weight.trend_kg}`,
    );
  });
});
