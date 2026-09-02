import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  backSolve,
  damp,
  energyDensity,
  fatFreeMassKg,
  fatMassKg,
  GOALS,
  proteinFromMultiplier,
  targetFromRate,
} from "../api/nutrition/expenditure.ts";
import {
  type DailyWeight,
  type TrendPoint,
  trendSeries,
} from "../api/body/trend.ts";

// Pure functions, no stack. This is the arithmetic that would be invisible if
// it were quietly wrong, so it gets tested against hand-computed values rather
// than against itself.

Deno.test("energy density follows Forbes, not a flat 7,700", async (t) => {
  await t.step("a lean trainee's kg costs less than 7,700", () => {
    // 82 kg at 14% -> FM 11.48, p = 10.4/21.88 = 0.4754
    // 0.4754*1020 + 0.5246*9440 = 485 + 4952 = 5437
    const lean = energyDensity(fatMassKg(82, 14));
    assertAlmostEquals(lean, 5437, 5);
    assert(lean < 7700);
  });

  await t.step("a fatter body's kg costs more, approaching pure fat", () => {
    const heavy = energyDensity(fatMassKg(120, 40));
    assert(heavy > energyDensity(fatMassKg(82, 14)));
    assert(heavy < 9440);
  });

  await t.step(
    "using 7,700 on a lean cut would overstate expenditure",
    () => {
      // The bias that matters: at -0.5 kg/week the flat constant credits
      // ~1,100 kcal/week of loss that did not happen.
      const slope = -0.5 / 7;
      const real = -slope * energyDensity(fatMassKg(82, 14));
      const flat = -slope * 7700;
      assert(flat - real > 150);
    },
  );
});

Deno.test("trend weight", async (t) => {
  await t.step("initializes at the first raw weigh-in", () => {
    const series = trendSeries([{ day: "2026-08-01", value_kg: 82.5 }]);
    assertEquals(series.length, 1);
    assertEquals(series[0].trend_kg, 82.5);
  });

  await t.step("lags the raw value, absorbing a spike", () => {
    const weights: DailyWeight[] = [
      { day: "2026-08-01", value_kg: 82.0 },
      { day: "2026-08-02", value_kg: 82.0 },
      { day: "2026-08-03", value_kg: 84.0 }, // a salty dinner
      { day: "2026-08-04", value_kg: 82.0 },
    ];
    const series = trendSeries(weights);
    const spikeDay = series.find((p) => p.day === "2026-08-03")!;
    // alpha 0.1: the 2 kg jump moves the trend by 0.2, not 2.
    assertEquals(spikeDay.trend_kg, 82.2);
    assert(spikeDay.trend_kg < 82.5);
  });

  await t.step("fills a single missing day by interpolation", () => {
    const series = trendSeries([
      { day: "2026-08-01", value_kg: 82.0 },
      { day: "2026-08-03", value_kg: 82.4 },
    ]);
    assertEquals(series.length, 3);
    assertEquals(series[1].day, "2026-08-02");
    assertEquals(series[1].weight_kg, 82.2);
    assertEquals(series[1].interpolated, true);
  });

  await t.step("does not invent values across a longer gap", () => {
    // A week of silence must not become a flat stretch: that would drag the
    // slope toward zero and read as a stalled diet.
    const series = trendSeries([
      { day: "2026-08-01", value_kg: 82.0 },
      { day: "2026-08-09", value_kg: 81.0 },
    ]);
    assertEquals(series.map((p) => p.day), ["2026-08-01", "2026-08-09"]);
    assertEquals(series.every((p) => !p.interpolated), true);
  });
});

// A 21-day window losing 0.5 kg/week at a steady 2,200 kcal logged.
function steadyCut(): {
  days: string[];
  intakeByDay: Map<string, number>;
  trend: TrendPoint[];
} {
  const days: string[] = [];
  const intakeByDay = new Map<string, number>();
  const weights: DailyWeight[] = [];
  const start = Date.parse("2026-07-13T00:00:00Z"); // a Monday
  for (let i = 0; i < 21; i++) {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    days.push(day);
    intakeByDay.set(day, 2200);
    weights.push({ day, value_kg: 82.0 - (0.5 / 7) * i });
  }
  return { days, intakeByDay, trend: trendSeries(weights) };
}

Deno.test("expenditure back-solve", async (t) => {
  await t.step("a steady cut solves above intake", () => {
    const { days, intakeByDay, trend } = steadyCut();
    const result = backSolve({
      days,
      intakeByDay,
      excludedDays: new Set(),
      trend,
      bodyfatPercent: 14,
    });
    assertEquals(result.status, "ok");
    assert(result.tdee_kcal! > 2200, "losing weight means TDEE exceeds intake");
    // Losing 0.5 kg/week at ~5,430 kcal/kg is ~390 kcal/day of stored energy.
    // The EMA lags the raw series, so the measured slope is shallower than
    // the true one and the estimate sits a little under 2,590.
    assert(result.tdee_kcal! > 2400 && result.tdee_kcal! < 2600);
    assertEquals(result.inputs!.mean_intake_kcal, 2200);
    assert(result.inputs!.slope_kg_per_day < 0);
  });

  await t.step("the band never claims precision it doesn't have", () => {
    const { days, intakeByDay, trend } = steadyCut();
    const result = backSolve({
      days,
      intakeByDay,
      excludedDays: new Set(),
      trend,
      bodyfatPercent: 14,
    });
    // The floor is 200, not 150: the validation data puts individual RMS at
    // ~215 kcal/day, so a narrower band would claim precision that does not
    // exist and invite the coach to chase noise.
    assert(result.band_kcal! >= 200);
    assert(result.band_kcal! <= 250);
  });

  await t.step("a thin window refuses rather than guesses", () => {
    const { intakeByDay, trend } = steadyCut();
    const result = backSolve({
      days: ["2026-07-13", "2026-07-14"],
      intakeByDay,
      excludedDays: new Set(),
      trend,
      bodyfatPercent: 14,
    });
    assertEquals(result.status, "insufficient_data");
    assertEquals(result.tdee_kcal, null);
  });

  await t.step("flagged days are excluded, not counted as zero", () => {
    const { days, intakeByDay, trend } = steadyCut();
    // Five untracked days, honestly flagged. Counting them as zero intake
    // would drag the mean by ~500 kcal and invent a huge deficit.
    const excludedDays = new Set(days.slice(0, 5));
    for (const d of excludedDays) intakeByDay.delete(d);
    const result = backSolve({
      days,
      intakeByDay,
      excludedDays,
      trend,
      bodyfatPercent: 14,
    });
    assertEquals(result.status, "ok");
    assertEquals(result.inputs!.mean_intake_kcal, 2200);
    assertEquals(result.window!.usable_days, 16);
  });

  await t.step("every blocker is reported, not just the first", () => {
    // Nothing logged and no body-fat estimate: both must come back, or the
    // coach solves one problem and meets the next a fortnight later.
    const { days, trend } = steadyCut();
    const result = backSolve({
      days,
      intakeByDay: new Map(),
      excludedDays: new Set(),
      trend,
      bodyfatPercent: null,
    });
    assertEquals(result.status, "insufficient_data");
    assertEquals(result.blockers.length, 2);
    assert(result.blockers.some((b) => b.includes("logged intake")));
    assert(result.blockers.some((b) => b.includes("body-fat")));
    assertEquals(result.reason, result.blockers.join(" "));
    // The window survives the refusal. The blockers describe it, and a reader
    // reconciling "0 weigh-in days" with this morning's weigh-in needs its
    // dates — stripping them exactly when the estimate fails was how a
    // working sync got reported as broken.
    assertEquals(result.window!.from, days[0]);
    assertEquals(result.window!.to, days[days.length - 1]);
  });

  await t.step("no body-fat estimate blocks the estimate", () => {
    const { days, intakeByDay, trend } = steadyCut();
    const result = backSolve({
      days,
      intakeByDay,
      excludedDays: new Set(),
      trend,
      bodyfatPercent: null,
    });
    assertEquals(result.status, "insufficient_data");
    assert(result.reason.includes("body-fat"));
  });

  await t.step("too few weigh-ins blocks the estimate", () => {
    const { days, intakeByDay } = steadyCut();
    const sparse = trendSeries([
      { day: "2026-07-13", value_kg: 82.0 },
      { day: "2026-07-27", value_kg: 81.0 },
      { day: "2026-08-02", value_kg: 80.5 },
    ]);
    const result = backSolve({
      days,
      intakeByDay,
      excludedDays: new Set(),
      trend: sparse,
      bodyfatPercent: 14,
    });
    assertEquals(result.status, "insufficient_data");
    // The unit is days, and the window is named by its dates. A count with
    // no window beside a rolling count with another is how three correct
    // numbers read as a contradiction.
    assert(result.reason.includes("weigh-in day"), result.reason);
    assert(result.reason.includes("2026-07-13 – 2026-08-02"), result.reason);
  });
});

Deno.test("damping absorbs a registered transient", async (t) => {
  const { days, intakeByDay, trend } = steadyCut();
  const base = backSolve({
    days,
    intakeByDay,
    excludedDays: new Set(),
    trend,
    bodyfatPercent: 14,
  });

  await t.step("a big jump with a transient on record is capped", () => {
    const damped = damp(base, base.tdee_kcal! - 600, {
      kind: "creatine_start",
      day: "2026-08-01",
    });
    assertEquals(damped.status, "damped");
    assertEquals(damped.tdee_kcal, base.tdee_kcal! - 600 + 100);
    assert(damped.reason.includes("creatine_start"));
  });

  await t.step("a big jump with no transient propagates", () => {
    // Nothing on record to blame: the coach is told the truth and decides.
    const undamped = damp(base, base.tdee_kcal! - 600, null);
    assertEquals(undamped.status, "ok");
    assertEquals(undamped.tdee_kcal, base.tdee_kcal);
  });

  await t.step("an ordinary week-to-week wobble is left alone", () => {
    const wobble = damp(base, base.tdee_kcal! - 80, {
      kind: "phase_switch",
      day: "2026-08-01",
    });
    assertEquals(wobble.status, "ok");
  });
});

Deno.test("target from rate", async (t) => {
  const density = energyDensity(fatMassKg(82, 14));

  await t.step("a default cut lands below expenditure", () => {
    const t1 = targetFromRate(2600, -0.5, 82, density, "cut");
    assert(t1.kcal_target < 2600);
    assertEquals(t1.clipped, false);
    // -0.5%/wk of 82 kg = -0.41 kg/wk = -0.0586 kg/day * 5437 = -319 kcal
    assertAlmostEquals(t1.implied_deficit_kcal, 319, 3);
  });

  await t.step("a gain target lands above expenditure", () => {
    const t2 = targetFromRate(2600, 0.25, 82, density, "gain");
    assert(t2.kcal_target > 2600);
    assertEquals(t2.clipped, false);
  });

  await t.step("maintenance is expenditure", () => {
    const t3 = targetFromRate(2600, 0, 82, density, "maintain");
    assertEquals(t3.kcal_target, 2600);
  });

  await t.step("an aggressive cut is clipped to 0.7%/week", () => {
    // The rate ceiling binds first at this bodyweight: -0.7% of 82 kg is a
    // ~446 kcal deficit, inside the 500 cap.
    const t4 = targetFromRate(2600, -1.5, 82, density, "cut");
    assertEquals(t4.clipped, true);
    assertEquals(t4.clipped_reasons, ["rate"]);
    assertEquals(t4.rate_requested, -1.5);
    assertEquals(t4.rate_used, -0.7);
    assert(t4.implied_deficit_kcal < 500);
  });

  await t.step("the deficit cap still binds at a heavier weight", () => {
    // A percentage and an absolute number diverge as weight changes: at 120 kg
    // a legal -0.7%/week implies more than 500 kcal/day, so the second guard
    // is the one that catches it. This is why both exist.
    const heavyDensity = energyDensity(fatMassKg(120, 30));
    const t5 = targetFromRate(3000, -0.7, 120, heavyDensity, "cut");
    assertEquals(t5.clipped, true);
    assertEquals(t5.clipped_reasons, ["deficit"]);
    assertEquals(t5.implied_deficit_kcal, 500);
    assertEquals(t5.kcal_target, 2500);
  });

  await t.step("a request that trips two guards reports both", () => {
    // -1.5%/week at 120 kg: the rate ceiling clips it to -0.7, and the
    // deficit that -0.7 implies at this weight still exceeds 500 kcal/day,
    // so the kcal cap re-binds. Both guards appear, in the order they fired,
    // and rate_used is the rate the delivered kcal implies — not the -0.7
    // the rate stage settled on, which the target no longer matches.
    const heavyDensity = energyDensity(fatMassKg(120, 30));
    const b = targetFromRate(3000, -1.5, 120, heavyDensity, "cut");
    assertEquals(b.clipped_reasons, ["rate", "deficit"]);
    assertEquals(b.kcal_target, 2500);
    assert(b.rate_used > -0.7);
    const back = 3000 + b.rate_used / 100 * 120 / 7 * heavyDensity;
    assertEquals(Math.round(back), 2500);
  });

  await t.step("a legal rate is untouched", () => {
    const t6 = targetFromRate(2600, -0.5, 82, density, "cut");
    assertEquals(t6.clipped, false);
    assertEquals(t6.clipped_reasons, []);
    assertEquals(t6.rate_used, -0.5);
  });

  await t.step("an aggressive gain is clipped to +0.5%/week", () => {
    // The mirror of the cut's rate guard. This passed through untouched for a
    // long while — clipped: false, a +3%/week "bulk" stored as legitimate —
    // because only the cut had guards and the gain ceiling lived in prose.
    const g = targetFromRate(2600, 3.0, 82, density, "gain");
    assertEquals(g.clipped, true);
    assertEquals(g.clipped_reasons, ["rate"]);
    assertEquals(g.rate_requested, 3.0);
    assertEquals(g.rate_used, 0.5);
  });

  await t.step("the surplus cap binds where the gain rate does not", () => {
    // Same divergence as the cut pair: at 120 kg a legal +0.5%/week implies
    // more surplus than 350 kcal/day, so the absolute guard is the one that
    // catches it.
    const heavyDensity = energyDensity(fatMassKg(120, 30));
    const s = targetFromRate(3000, 0.5, 120, heavyDensity, "gain");
    assertEquals(s.clipped, true);
    assertEquals(s.clipped_reasons, ["surplus"]);
    assertEquals(s.kcal_target, 3350);
  });

  await t.step("a recomp deficit is clipped at the doctrine's floor", () => {
    // "Maintenance to −200 kcal/day" is a kcal rule, so it is enforced in
    // kcal. A −0.5%/week request at 82 kg implies ~319 kcal/day — legal for a
    // cut, past the floor for a recomp — and the reason names the doctrine.
    const r = targetFromRate(2600, -0.5, 82, density, "recomp");
    assertEquals(r.clipped, true);
    assertEquals(r.clipped_reasons, ["recomp_deficit"]);
    assertEquals(r.kcal_target, 2400);
    assertEquals(r.implied_deficit_kcal, 200);
  });

  await t.step("a gentle recomp is untouched", () => {
    // −0.15%/week at 82 kg is ~96 kcal/day, inside the doctrine's band.
    const r = targetFromRate(2600, -0.15, 82, density, "recomp");
    assertEquals(r.clipped, false);
    assertEquals(r.clipped_reasons, []);
  });

  await t.step("every goal has a lane through the arithmetic", () => {
    // Coverage by enumeration: recomp had zero tests once, and nobody noticed
    // until an outside reviewer asked what a recomp rate even meant. Each
    // goal value must pass through targetFromRate in this suite, so a new
    // goal cannot ship untested.
    for (const goal of GOALS) {
      const result = targetFromRate(2600, 0, 82, density, goal);
      assertEquals(result.kcal_target, 2600);
      assertEquals(result.clipped, false);
    }
  });
});

Deno.test("protein targets are computed, not handed in", async (t) => {
  await t.step("the deficit basis is fat-free mass", () => {
    // 82 kg at 14% -> FFM 70.52; muscle retention scales with the mass being
    // retained, not with the fat being lost.
    assertAlmostEquals(fatFreeMassKg(82, 14), 70.52, 0.01);
    const p = proteinFromMultiplier("ffm", 2.7, 82, 14);
    assertEquals(p.protein_g_target, 190); // 2.7 * 70.52 = 190.4
    assertEquals(p.basis, "ffm");
    assertEquals(p.basis_mass_kg, 70.5);
  });

  await t.step("maintenance uses bodyweight and ignores body fat", () => {
    const p = proteinFromMultiplier("bodyweight", 1.8, 82, 14);
    assertEquals(p.protein_g_target, 148); // 1.8 * 82
    assertEquals(p.basis_mass_kg, 82);
  });

  await t.step("the two bases differ enough to matter", () => {
    // ~40 g/day apart at the same multiplier: reason enough not to let the
    // model do this multiplication in its head.
    const ffm = proteinFromMultiplier("ffm", 2.2, 82, 14).protein_g_target;
    const bw =
      proteinFromMultiplier("bodyweight", 2.2, 82, 14).protein_g_target;
    assert(bw - ffm > 20);
  });
});
