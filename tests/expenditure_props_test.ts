import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  backSolve,
  damp,
  daysBetween,
  DEFAULT_ALPHA,
  energyDensity,
  fatMassKg,
  GOALS,
  MAX_DEFICIT_KCAL,
  MAX_GAIN_RATE_PCT_BW_WEEK,
  MAX_LOSS_RATE_PCT_BW_WEEK,
  MAX_RECOMP_DEFICIT_KCAL,
  MAX_SURPLUS_KCAL,
  MIN_WINDOW_DAYS,
  targetFromRate,
  trendSeries,
} from "../supabase/functions/api/lib/expenditure.ts";
import type {
  DailyWeight,
  Expenditure,
  WindowInput,
} from "../supabase/functions/api/lib/expenditure.ts";

// Properties, not examples. expenditure_test.ts pins hand-computed values at
// chosen points; this file states the laws those points are instances of and
// lets fast-check hunt the input space for a counterexample. The module's own
// header says why it earns the extra scrutiny: it is the only arithmetic in
// the system where being quietly wrong would be invisible for weeks.
//
// fast-check comes in through deno.json's "fast-check": "npm:fast-check@^4" —
// Deno resolves npm packages directly from an npm: specifier, no package.json
// or node_modules needed. A failing property prints the seed and the shrunken
// counterexample; re-run with that seed to reproduce.

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 1997–2079 as epoch days, so every generated window straddles DST
// transitions somewhere. All of this arithmetic is UTC-anchored on purpose;
// the property runs would catch a "fix" that made it local.
const isoDay = fc.integer({ min: 10_000, max: 40_000 })
  .map((n) => new Date(n * 86_400_000).toISOString().slice(0, 10));

const kg = fc.double({ min: 40, max: 150, noNaN: true }).map(round2);

/** Weigh-ins on irregular days: a start day, then gaps of 1–4 days. */
const weighIns = fc.tuple(
  isoDay,
  kg,
  fc.array(
    fc.record({ gap: fc.integer({ min: 1, max: 4 }), kg }),
    { maxLength: 40 },
  ),
).map(([start, firstKg, steps]) => {
  const out: DailyWeight[] = [{ day: start, value_kg: firstKg }];
  let day = start;
  for (const s of steps) {
    day = addDays(day, s.gap);
    out.push({ day, value_kg: s.kg });
  }
  return out;
});

Deno.test("daysBetween is calendar arithmetic", () => {
  // Antisymmetry and additivity through any midpoint. Together they say the
  // function measures distance on the calendar rather than elapsed clock
  // time, which is what would break in the DST weeks if anyone rewrote it on
  // local Dates.
  fc.assert(fc.property(isoDay, isoDay, isoDay, (a, b, c) => {
    assertEquals(daysBetween(a, b), -daysBetween(b, a));
    assertEquals(daysBetween(a, b) + daysBetween(b, c), daysBetween(a, c));
    assertEquals(daysBetween(a, a), 0);
  }));
});

Deno.test("trendSeries laws", async (t) => {
  await t.step("starts at the first weigh-in, stays inside the data", () => {
    // An EMA is a convex combination of what it has seen, so it can never
    // leave the range of its inputs. A sign or weighting slip breaks this
    // instantly, on almost any input.
    fc.assert(fc.property(weighIns, (ws) => {
      const series = trendSeries(ws);
      assertEquals(series[0].day, ws[0].day);
      assertEquals(series[0].trend_kg, ws[0].value_kg);
      const lo = Math.min(...ws.map((w) => w.value_kg)) - 0.005;
      const hi = Math.max(...ws.map((w) => w.value_kg)) + 0.005;
      for (const p of series) {
        assert(p.trend_kg >= lo && p.trend_kg <= hi, `${p.trend_kg} escapes`);
        assert(p.weight_kg >= lo && p.weight_kg <= hi);
      }
    }));
  });

  await t.step("a constant weight is a fixed point", () => {
    // Every point — real or interpolated — must report exactly the constant.
    // This is the cheapest detector of accumulator drift and rounding leaks.
    fc.assert(fc.property(weighIns, kg, (ws, k) => {
      const flat = ws.map((w) => ({ ...w, value_kg: k }));
      for (const p of trendSeries(flat)) {
        assertEquals(p.trend_kg, k);
        assertEquals(p.weight_kg, k);
      }
    }));
  });

  await t.step("input order does not matter", () => {
    // The SQL that feeds this orders by day, but the function no longer
    // trusts that: a reversed array used to yield a silently truncated
    // series initialized at the wrong weigh-in.
    fc.assert(fc.property(weighIns, (ws) => {
      assertEquals(trendSeries([...ws].reverse()), trendSeries(ws));
    }));
  });

  await t.step(
    "each step moves at most alpha of the way to the weigh-in",
    () => {
      // The contraction |Δtrend| ≤ α·|weight − trend| is the "absorbs a spike"
      // claim stated as a law: one wild morning can move the trend a tenth of
      // the way at most. Slack covers the 2-decimal rounding of both sides.
      fc.assert(fc.property(weighIns, (ws) => {
        const series = trendSeries(ws);
        for (let i = 1; i < series.length; i++) {
          const step = Math.abs(series[i].trend_kg - series[i - 1].trend_kg);
          const gap = Math.abs(series[i].weight_kg - series[i - 1].trend_kg);
          assert(step <= DEFAULT_ALPHA * gap + 0.02, `step ${step} > α·${gap}`);
        }
      }));
    },
  );

  await t.step("exactly the one-day gaps are interpolated", () => {
    // A missing day appears iff both neighbours were weighed, carries their
    // mean, and is flagged; longer gaps emit nothing rather than inventing a
    // flat stretch. Computed from the raw day set, not from the output.
    fc.assert(fc.property(weighIns, (ws) => {
      const have = new Map(ws.map((w) => [w.day, w.value_kg]));
      const series = trendSeries(ws);
      const emitted = new Map(series.map((p) => [p.day, p]));
      const first = series[0].day;
      const last = ws.map((w) => w.day).sort().at(-1)!;
      for (let d = first; daysBetween(d, last) >= 0; d = addDays(d, 1)) {
        const real = have.has(d);
        const bridged = !real && have.has(addDays(d, -1)) &&
          have.has(addDays(d, 1));
        assertEquals(emitted.has(d), real || bridged, d);
        if (bridged) {
          const p = emitted.get(d)!;
          assertEquals(p.interpolated, true);
          assertAlmostEquals(
            p.weight_kg,
            (have.get(addDays(d, -1))! + have.get(addDays(d, 1))!) / 2,
            0.006,
          );
        }
        if (real) assertEquals(emitted.get(d)!.interpolated, false);
      }
    }));
  });
});

// --- backSolve --------------------------------------------------------------

/** A window that satisfies every requirement: N whole weeks, all days logged,
 * a weigh-in every day, a body-fat figure on record. */
const fullWindow = fc.record({
  start: isoDay,
  weeks: fc.integer({ min: 2, max: 4 }),
  intakes: fc.array(fc.integer({ min: 1200, max: 4000 }), {
    minLength: 28,
    maxLength: 28,
  }),
  kgs: fc.array(kg, { minLength: 28, maxLength: 28 }),
  bodyfat: fc.integer({ min: 5, max: 45 }),
}).map(({ start, weeks, intakes, kgs, bodyfat }) => {
  const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  const weights = days.map((day, i) => ({ day, value_kg: kgs[i] }));
  return {
    days,
    intakeByDay: new Map(days.map((d, i) => [d, intakes[i]])),
    excludedDays: new Set<string>(),
    trend: trendSeries(weights),
    bodyfatPercent: bodyfat,
    weights,
  };
});

/** Arbitrary, possibly deficient input: short windows, patchy logging,
 * sparse weigh-ins, maybe no body-fat. The blocker laws must hold on all of
 * it, including the empty window. */
const anyWindow = fc.record({
  start: isoDay,
  len: fc.integer({ min: 0, max: 30 }),
  logged: fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }),
  weighed: fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }),
  excluded: fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }),
  intakes: fc.array(fc.integer({ min: 0, max: 5000 }), {
    minLength: 30,
    maxLength: 30,
  }),
  kgs: fc.array(kg, { minLength: 30, maxLength: 30 }),
  bodyfat: fc.option(fc.integer({ min: 5, max: 45 }), { nil: null }),
}).map((r): WindowInput => {
  const days = Array.from({ length: r.len }, (_, i) => addDays(r.start, i));
  const weights = days.filter((_, i) => r.weighed[i])
    .map((day) => ({ day, value_kg: r.kgs[days.indexOf(day)] }));
  return {
    days,
    intakeByDay: new Map(
      days.filter((_, i) => r.logged[i]).map((d) => [
        d,
        r.intakes[days.indexOf(d)],
      ]),
    ),
    excludedDays: new Set(days.filter((_, i) => r.excluded[i])),
    trend: trendSeries(weights),
    bodyfatPercent: r.bodyfat,
  };
});

Deno.test("backSolve laws", async (t) => {
  await t.step("a flat trend back-solves to exactly the mean intake", () => {
    // With no weight change the stored-energy term is zero and body
    // composition must drop out entirely — the same answer at 5% and 45%
    // body fat. The strongest cheap oracle the identity offers.
    fc.assert(fc.property(fullWindow, kg, (w, flat) => {
      const weights = w.days.map((day) => ({ day, value_kg: flat }));
      const e = backSolve({ ...w, trend: trendSeries(weights) });
      assertEquals(e.status, "ok");
      const mean = w.days.reduce((s, d) => s + w.intakeByDay.get(d)!, 0) /
        w.days.length;
      assertEquals(e.tdee_kcal, Math.round(mean));
    }));
  });

  await t.step("losing weight means expenditure above intake", () => {
    // The sign of the correction is the part a refactor is most likely to
    // flip, and the one error the band could never excuse.
    fc.assert(fc.property(fullWindow, (w) => {
      const weights = w.days.map((day, i) => ({
        day,
        value_kg: round2(100 - i * 0.1),
      }));
      const e = backSolve({ ...w, trend: trendSeries(weights) });
      assertEquals(e.status, "ok");
      assert(e.tdee_kcal! >= e.inputs!.mean_intake_kcal);
    }));
  });

  await t.step("the reported numbers agree with each other", () => {
    // tdee = mean − slope × density, recomputed from the response's own
    // inputs block. Not a tautology: it fails if the response reports inputs
    // from one code path and a tdee from another.
    fc.assert(fc.property(fullWindow, (w) => {
      const e = backSolve(w);
      assertEquals(e.status, "ok");
      const i = e.inputs!;
      // The tolerance is the rounding of the reported inputs, not slack in
      // the identity: mean ±0.5, slope ±0.00005 × density ≤ 9440, and
      // density ±0.5 × |slope| ≤ ~8.5 kg/day on these wild windows — about
      // 5.7 kcal worst case. A real inconsistency would miss by hundreds.
      assertAlmostEquals(
        e.tdee_kcal!,
        i.mean_intake_kcal - i.slope_kg_per_day * i.energy_density_kcal_per_kg,
        8,
      );
      assert(e.band_kcal! >= 200 && e.band_kcal! <= 250);
    }));
  });

  await t.step("blockers and status tell one story, on any input", () => {
    // insufficient_data iff at least one blocker; the reason is exactly the
    // blockers joined; nothing interpolates "undefined" (the empty window
    // once did); and it never throws. Totality is the property that lets the
    // route call this without defending itself.
    fc.assert(fc.property(anyWindow, (w) => {
      const e = backSolve(w);
      assertEquals(e.status === "insufficient_data", e.blockers.length > 0);
      if (e.blockers.length > 0) {
        assertEquals(e.reason, e.blockers.join(" "));
      }
      assert(!e.reason.includes("undefined"), e.reason);
      if (e.status === "ok") {
        assert(e.tdee_kcal !== null && e.band_kcal !== null);
        assert(e.window !== null && e.inputs !== null);
      }
    }));
  });

  await t.step("excluding a day can only shrink the window", () => {
    // The incomplete flag removes a day from the mean instead of counting it
    // as zero. Stated algebraically: usable_days never grows, and the mean
    // is the mean of exactly the surviving days.
    fc.assert(
      fc.property(fullWindow, fc.integer({ min: 0, max: 27 }), (w, pick) => {
        const day = w.days[pick % w.days.length];
        const base = backSolve(w);
        const cut = backSolve({ ...w, excludedDays: new Set([day]) });
        assertEquals(cut.window!.usable_days, base.window!.usable_days - 1);
        if (cut.status === "ok") {
          const rest = w.days.filter((d) => d !== day);
          const mean = rest.reduce((s, d) => s + w.intakeByDay.get(d)!, 0) /
            rest.length;
          assertEquals(cut.inputs!.mean_intake_kcal, Math.round(mean));
        }
      }),
    );
  });

  await t.step("the documented thresholds are the ones enforced", () => {
    // A full window passes; the same window one logged day short of
    // MIN_WINDOW_DAYS blocks. Ties the constant to behaviour so the constant
    // cannot drift away from the check it names.
    fc.assert(fc.property(fullWindow, (w) => {
      assertEquals(backSolve(w).status, "ok");
      const starved = new Map(
        [...w.intakeByDay].slice(0, MIN_WINDOW_DAYS - 1),
      );
      const e = backSolve({ ...w, intakeByDay: starved });
      assertEquals(e.status, "insufficient_data");
    }));
  });
});

// --- Targets ----------------------------------------------------------------

const targetArgs = fc.record({
  tdee: fc.integer({ min: 1200, max: 4500 }),
  rate: fc.double({ min: -5, max: 5, noNaN: true }),
  weight: kg,
  bodyfat: fc.integer({ min: 5, max: 45 }),
  goal: fc.constantFrom(...GOALS),
}).map((r) => ({
  ...r,
  density: energyDensity(fatMassKg(r.weight, r.bodyfat)),
}));

Deno.test("targetFromRate laws", async (t) => {
  await t.step("every guard holds at once, for any request", () => {
    // Each bound is example-tested at a point where it binds alone;
    // this asserts all four simultaneously across the whole input space,
    // which is where an ordering bug between the clips would hide.
    fc.assert(
      fc.property(targetArgs, ({ tdee, rate, weight, density, goal }) => {
        const r = targetFromRate(tdee, rate, weight, density, goal);
        assertEquals(r.clipped, r.clipped_reason !== null);
        assert(r.rate_used >= -MAX_LOSS_RATE_PCT_BW_WEEK);
        assert(r.rate_used <= MAX_GAIN_RATE_PCT_BW_WEEK);
        assert(r.implied_deficit_kcal <= MAX_DEFICIT_KCAL);
        assert(-r.implied_deficit_kcal <= MAX_SURPLUS_KCAL);
        if (goal === "recomp") {
          assert(r.implied_deficit_kcal <= MAX_RECOMP_DEFICIT_KCAL);
        }
      }),
    );
  });

  await t.step("clipping is a projection", () => {
    // Re-requesting the rate that was actually used returns the same target:
    // the guards map every request onto the allowed region and are the
    // identity on it. If this failed, a coach re-sending the server's own
    // answer would get a different answer.
    fc.assert(
      fc.property(targetArgs, ({ tdee, rate, weight, density, goal }) => {
        const once = targetFromRate(tdee, rate, weight, density, goal);
        const twice = targetFromRate(
          tdee,
          once.rate_used,
          weight,
          density,
          goal,
        );
        assertEquals(twice.kcal_target, once.kcal_target);
        assertEquals(twice.implied_deficit_kcal, once.implied_deficit_kcal);
      }),
    );
  });

  await t.step("rate zero is maintenance, for every goal", () => {
    fc.assert(fc.property(targetArgs, ({ tdee, weight, density, goal }) => {
      const r = targetFromRate(tdee, 0, weight, density, goal);
      assertEquals(r.kcal_target, tdee);
      assertEquals(r.clipped, false);
    }));
  });

  await t.step("a faster rate never means fewer calories", () => {
    fc.assert(
      fc.property(
        targetArgs,
        fc.double({ min: -5, max: 5, noNaN: true }),
        ({ tdee, rate, weight, density, goal }, other) => {
          const [lo, hi] = rate <= other ? [rate, other] : [other, rate];
          const a = targetFromRate(tdee, lo, weight, density, goal);
          const b = targetFromRate(tdee, hi, weight, density, goal);
          assert(a.kcal_target <= b.kcal_target);
        },
      ),
    );
  });
});

Deno.test("damp caps the step and says so", () => {
  const ok = (tdee: number): Expenditure => ({
    status: "ok",
    reason: "",
    blockers: [],
    tdee_kcal: tdee,
    band_kcal: 210,
    window: null,
    inputs: null,
  });
  fc.assert(
    fc.property(
      fc.integer({ min: 1200, max: 4500 }),
      fc.integer({ min: 1200, max: 4500 }),
      (current, previous) => {
        const d = damp(ok(current), previous, { kind: "cheat day", day: "x" });
        const step = current - previous;
        if (Math.abs(step) <= 300) {
          assertEquals(d, ok(current)); // untouched, including status
        } else {
          assertEquals(d.status, "damped");
          assertEquals(d.tdee_kcal, previous + Math.sign(step) * 100);
          assert(d.band_kcal! >= 250);
        }
      },
    ),
  );
});

Deno.test("energyDensity interpolates Forbes between the two tissues", () => {
  // Bounded by the pure-tissue densities, increasing in fatness, and exactly
  // fat-free at zero fat mass. The flat 7,700 the docs argue against is
  // inside the range — the function must be able to disagree with it.
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 80, noNaN: true }),
      fc.double({ min: 0, max: 80, noNaN: true }),
      (a, b) => {
        const d = energyDensity(a);
        assert(d >= 1020 && d <= 9440);
        // Non-strict at float resolution; strict once the masses differ by
        // an amount a scale could ever report.
        if (a < b) assert(d <= energyDensity(b));
        if (a + 0.01 < b) assert(d < energyDensity(b));
      },
    ),
  );
  assertEquals(energyDensity(0), 1020);
});
