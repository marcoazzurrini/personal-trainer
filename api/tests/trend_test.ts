import { assertEquals } from "@std/assert";
import { api, daysAgo, resetNutrition } from "./helpers.ts";

// Every test owns its fixture, so filtering or shuffling tests cannot change
// the series. Deliberately disagree on sources, time of day, and UTC/Rome day.
async function seedTrend() {
  await resetNutrition();
  const rows = [
    { value_kg: 80, measured_at: `${daysAgo(6)}T05:45:00Z`, source: "manual" },
    {
      value_kg: 90,
      measured_at: `${daysAgo(6)}T05:45:00Z`,
      source: "withings",
    },
    { value_kg: 82, measured_at: `${daysAgo(4)}T05:00:00Z`, source: "morning" },
    { value_kg: 84, measured_at: `${daysAgo(4)}T19:00:00Z`, source: "evening" },
    { value_kg: 81.5, measured_at: `${daysAgo(3)}T23:30:00Z`, source: "late" },
  ];
  const ids: number[] = [];
  for (const row of rows) {
    const result = await api.post("/bodyweight", row);
    assertEquals(result.status, 201);
    ids.push(result.body.bodyweight.id);
  }
  return ids;
}

// Independently calculated at alpha = 0.1; do not use trendSeries as its own
// oracle. The internal EMA retains precision between output points.
function expectedTrend() {
  return [
    { day: daysAgo(6), weight_kg: 80, trend_kg: 80, interpolated: false },
    { day: daysAgo(5), weight_kg: 81, trend_kg: 80.1, interpolated: true },
    { day: daysAgo(4), weight_kg: 82, trend_kg: 80.29, interpolated: false },
    { day: daysAgo(3), weight_kg: 81.75, trend_kg: 80.44, interpolated: true },
    { day: daysAgo(2), weight_kg: 81.5, trend_kg: 80.54, interpolated: false },
  ];
}

Deno.test("one weight per Rome day feeds the exact collapsed trend", async () => {
  await seedTrend();
  const state = await api.get("/nutrition-state");
  assertEquals(state.status, 200);
  const weights = new Map(
    state.body.recent_days.map((
      r: { day: string; weight_kg: number | null },
    ) => [r.day, r.weight_kg]),
  );
  assertEquals(weights.get(daysAgo(6)), 80); // First source wins ties.
  assertEquals(weights.get(daysAgo(4)), 82); // Earliest instant, not evening.
  assertEquals(weights.get(daysAgo(3)), null); // UTC date is not Rome date.
  assertEquals(weights.get(daysAgo(2)), 81.5);
  assertEquals(state.body.trend_weight.day, daysAgo(2));
  assertEquals(state.body.trend_weight.trend_kg, 80.54);
});

Deno.test("the bodyweight read serves the exact trend beside all raw rows", async () => {
  await seedTrend();
  const series = await api.get("/bodyweight");
  assertEquals(series.status, 200);
  assertEquals(series.body.bodyweight.length, 5);
  assertEquals(series.body.trend, expectedTrend());
  const state = await api.get("/nutrition-state");
  assertEquals(state.status, 200);
  assertEquals(series.body.trend.at(-1).day, state.body.trend_weight.day);
  assertEquals(
    series.body.trend.at(-1).trend_kg,
    state.body.trend_weight.trend_kg,
  );
});

Deno.test("deleting the selected weigh-in promotes the next one on that day", async () => {
  const ids = await seedTrend();
  assertEquals((await api.delete(`/bodyweight/${ids[2]}`)).status, 200);
  const series = await api.get("/bodyweight");
  assertEquals(series.status, 200);
  assertEquals(series.body.bodyweight.length, 4);
  assertEquals(series.body.trend, [
    { day: daysAgo(6), weight_kg: 80, trend_kg: 80, interpolated: false },
    { day: daysAgo(5), weight_kg: 82, trend_kg: 80.2, interpolated: true },
    { day: daysAgo(4), weight_kg: 84, trend_kg: 80.58, interpolated: false },
    { day: daysAgo(3), weight_kg: 82.75, trend_kg: 80.8, interpolated: true },
    { day: daysAgo(2), weight_kg: 81.5, trend_kg: 80.87, interpolated: false },
  ]);
});
