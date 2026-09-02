import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  checkEnergy,
  checkMacroMass,
  gramsEaten,
  scaleFood,
  sumMacros,
} from "../api/nutrition/rules.ts";
import type { FoodMacros, Logged } from "../api/nutrition/rules.ts";
import { ApiError } from "../api/shared/errors.ts";

// The laws behind the nutrition arithmetic. nutrition_test.ts checks these
// functions through the API at chosen values; this file states what must hold
// at every value. Additivity gets the most attention because it is the whole
// justification for daily and weekly totals being sums.

/** One decimal, like the numeric(_, 1) columns these values round-trip with. */
const g1 = fc.double({ min: 0, max: 500, noNaN: true })
  .map((v) => Math.round(v * 10) / 10);

const food: fc.Arbitrary<FoodMacros> = fc.record({
  kcal_100g: fc.integer({ min: 0, max: 900 }),
  protein_100g: g1.map((v) => Math.min(v, 100)),
  carbs_100g: g1.map((v) => Math.min(v, 100)),
  fat_100g: g1.map((v) => Math.min(v, 100)),
  fiber_100g: fc.option(g1.map((v) => Math.min(v, 100)), { nil: null }),
});

const grams = fc.double({ min: 0.1, max: 2000, noNaN: true })
  .map((v) => Math.round(v * 10) / 10);

Deno.test("scaleFood laws", async (t) => {
  await t.step("100 g of a food is the food", () => {
    fc.assert(fc.property(food, (f) => {
      const s = scaleFood(f, 100);
      assertEquals(s.kcal, f.kcal_100g);
      assertEquals(s.protein_g, f.protein_100g);
      assertEquals(s.carbs_g, f.carbs_100g);
      assertEquals(s.fat_g, f.fat_100g);
      assertEquals(s.fiber_g, f.fiber_100g);
    }));
  });

  await t.step("twice the grams is twice the food, within rounding", () => {
    fc.assert(fc.property(food, grams, (f, g) => {
      const one = scaleFood(f, g);
      const two = scaleFood(f, 2 * g);
      assertAlmostEquals(two.kcal, 2 * one.kcal, 0.21);
      assertAlmostEquals(two.protein_g, 2 * one.protein_g, 0.21);
      assertAlmostEquals(two.fat_g, 2 * one.fat_g, 0.21);
    }));
  });

  await t.step("unknown fibre stays unknown at every amount", () => {
    // Null is "the label does not say", and no amount of scaling can turn
    // that into a number — or a number into ignorance.
    fc.assert(fc.property(food, grams, (f, g) => {
      assertEquals(scaleFood(f, g).fiber_g === null, f.fiber_100g === null);
    }));
  });
});

// --- sumMacros --------------------------------------------------------------

const loggedRow: fc.Arbitrary<Partial<Logged>> = fc.record({
  kcal: g1,
  protein_g: fc.option(g1, { nil: null }),
  carbs_g: fc.option(g1, { nil: null }),
  fat_g: fc.option(g1, { nil: null }),
  fiber_g: fc.option(g1, { nil: null }),
});

const rows = fc.array(loggedRow, { maxLength: 30 });

const MACROS = ["protein_g", "carbs_g", "fat_g", "fiber_g"] as const;

Deno.test("sumMacros laws", async (t) => {
  await t.step("order does not matter", () => {
    fc.assert(fc.property(rows, (rs) => {
      const a = sumMacros(rs);
      const b = sumMacros([...rs].reverse());
      assertAlmostEquals(a.kcal, b.kcal, 0.11);
      for (const m of MACROS) {
        assertEquals(a[m] === null, b[m] === null);
        if (a[m] !== null) assertAlmostEquals(a[m]!, b[m]!, 0.11);
      }
    }));
  });

  await t.step("two days concatenated total like two days added", () => {
    // Additivity is what makes a weekly figure legitimate: summing seven
    // daily totals must agree with totalling the week's rows directly.
    // Null-aware, because null is "no row said", not zero.
    fc.assert(fc.property(rows, rows, (a, b) => {
      const whole = sumMacros([...a, ...b]);
      const pa = sumMacros(a);
      const pb = sumMacros(b);
      assertAlmostEquals(whole.kcal, pa.kcal + pb.kcal, 0.21);
      for (const m of MACROS) {
        if (pa[m] === null && pb[m] === null) {
          assertEquals(whole[m], null);
        } else {
          assertAlmostEquals(whole[m]!, (pa[m] ?? 0) + (pb[m] ?? 0), 0.21);
        }
      }
    }));
  });

  await t.step("unaccounted is an exact ledger of the gaps", () => {
    // A macro total over rows that don't all carry it is a floor, and
    // unaccounted says precisely how much energy the floor is silent about:
    // entry counts exact, kcal the sum over exactly the silent rows, present
    // iff there is a gap at all.
    fc.assert(fc.property(rows, (rs) => {
      const t = sumMacros(rs);
      for (const m of MACROS) {
        const silent = rs.filter((r) => r[m] === null || r[m] === undefined);
        if (silent.length === 0) {
          assertEquals(t.unaccounted[m], undefined);
        } else {
          assertEquals(t.unaccounted[m]!.entries, silent.length);
          assertAlmostEquals(
            t.unaccounted[m]!.kcal,
            silent.reduce((s, r) => s + Number(r.kcal ?? 0), 0),
            0.11,
          );
        }
      }
    }));
  });

  await t.step("no rows means null macros and a clean ledger", () => {
    const t = sumMacros([]);
    assertEquals(t, {
      kcal: 0,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      fiber_g: null,
      unaccounted: {},
    });
  });
});

// --- The two sanity checks --------------------------------------------------

function throws422(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    assert(e instanceof ApiError && e.status === 422);
    return true;
  }
}

Deno.test("checkEnergy law: rejects exactly outside the tolerance", () => {
  // The check must mirror its own contract — |stated − implied| beyond 15%
  // with a 20 kcal floor — and a label that states precisely what its macros
  // imply must never be refused. The floor is what keeps black coffee
  // loggable, so it is part of the law, not an implementation detail.
  fc.assert(
    fc.property(
      g1.map((v) => Math.min(v, 100)),
      g1.map((v) => Math.min(v, 100)),
      g1.map((v) => Math.min(v, 100)),
      fc.integer({ min: 0, max: 900 }),
      (p, c, f, kcal) => {
        const implied = 4 * p + 4 * c + 9 * f;
        const allowed = Math.max(implied * 0.15, 20);
        const out = Math.abs(kcal - implied) > allowed;
        assertEquals(
          throws422(() => checkEnergy(kcal, p, c, f, false, null)),
          out,
        );
        // The self-consistent label always passes.
        assertEquals(
          throws422(() => checkEnergy(implied, p, c, f, false, null)),
          false,
        );
        // An override with a written reason always passes; without one it is
        // refused wherever the plain check would have refused.
        assertEquals(
          throws422(() => checkEnergy(kcal, p, c, f, true, "alcohol")),
          false,
        );
        assertEquals(
          throws422(() => checkEnergy(kcal, p, c, f, true, null)),
          out,
        );
      },
    ),
  );
});

Deno.test("checkMacroMass law: 105 g per 100 g, exactly", () => {
  fc.assert(fc.property(g1, g1, g1, (p, c, f) => {
    assertEquals(
      throws422(() => checkMacroMass(p, c, f)),
      p + c + f > 105,
    );
  }));
});

Deno.test("gramsEaten is total, with exactly four outcomes", () => {
  // Either grams passes through, units convert, or the refusal names what is
  // missing — never a fifth behaviour, never an unhandled case.
  const maybe = fc.option(grams, { nil: null });
  fc.assert(fc.property(maybe, maybe, maybe, (g, u, gpu) => {
    const run = () => gramsEaten(g, u, gpu, "Test Food");
    if (g !== null && u !== null) assert(throws422(run));
    else if (g !== null) assertEquals(run(), g);
    else if (u !== null && gpu !== null) {
      assertEquals(run(), Math.round(u * gpu * 10) / 10);
    } else assert(throws422(run));
  }));
});
