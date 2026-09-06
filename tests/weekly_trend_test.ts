import { assertEquals } from "@std/assert";
import { weeklyTrendChange } from "../api/nutrition/expenditure.ts";

Deno.test("weeklyTrendChange uses six elapsed days for daily energy and seven for weekly rate", () => {
  const start = { day: "2026-03-23", trend_kg: 80 };
  // Includes Rome's spring DST change. Density is an independent known input,
  // not obtained by calling the implementation's Forbes function in the oracle.
  for (
    const [endKg, delta, rate, tdee] of [
      [79.4, -0.6, -0.87, 2700],
      [80, 0, 0, 2200],
      [80.6, 0.6, 0.87, 1700],
    ]
  ) {
    assertEquals(
      weeklyTrendChange(
        start,
        { day: "2026-03-29", trend_kg: endKg },
        2200,
        5000,
      ),
      {
        trend_delta_kg: delta,
        rate_pct_bw_week: rate,
        implied_tdee_kcal: tdee,
      },
    );
  }
  // Same slope over ten elapsed days: neither denominator is a fixed six/seven.
  assertEquals(
    weeklyTrendChange(start, { day: "2026-04-02", trend_kg: 79 }, 2200, 5000),
    {
      trend_delta_kg: -1,
      rate_pct_bw_week: -0.88,
      implied_tdee_kcal: 2700,
    },
  );
});

Deno.test("weeklyTrendChange does not invent missing endpoints or usable denominators", () => {
  const start = { day: "2026-10-19", trend_kg: 80 };
  const finish = { day: "2026-10-25", trend_kg: 79.4 };
  for (
    const [a, b] of [[undefined, finish], [start, undefined], [{
      ...start,
      trend_kg: NaN,
    }, finish]]
  ) {
    assertEquals(weeklyTrendChange(a, b, 2200, 5000), {
      trend_delta_kg: null,
      rate_pct_bw_week: null,
      implied_tdee_kcal: null,
    });
  }
  for (const day of [start.day, "2026-10-18", "invalid"]) {
    assertEquals(weeklyTrendChange(start, { ...finish, day }, 2200, 5000), {
      trend_delta_kg: -0.6,
      rate_pct_bw_week: null,
      implied_tdee_kcal: null,
    });
  }
  for (const weight of [0, -1]) {
    assertEquals(
      weeklyTrendChange({ ...start, trend_kg: weight }, finish, 2200, 5000)
        .rate_pct_bw_week,
      null,
    );
  }
  for (
    const [kcal, density] of [
      [null, 5000],
      [2200, null],
      [2200, 0],
      [2200, -1],
      [2200, Infinity],
      [NaN, 5000],
    ]
  ) {
    const result = weeklyTrendChange(start, finish, kcal, density);
    assertEquals(result.implied_tdee_kcal, null);
    assertEquals(result.trend_delta_kg, -0.6);
    assertEquals(result.rate_pct_bw_week, -0.87);
  }
});
