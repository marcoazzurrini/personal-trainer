import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  assertDoseUnit,
  assertSetMeasures,
  deliveredInDoseUnit,
  DOSE_UNITS,
  doseUnitsFor,
  MEASURES,
} from "../supabase/functions/api/rules/training.ts";
import type { SetMeasures } from "../supabase/functions/api/rules/training.ts";
import { ApiError } from "../supabase/functions/api/http/errors.ts";

// The measure table, restated as behaviour. training.ts holds one RULES table
// read from three sides — what a set may carry, which units a dose may use,
// how delivered work converts — and these tests pin the three sides to each
// other and to this spec, so a table edit that breaks their agreement fails
// here by name.

interface Spec {
  needs: readonly ("reps" | "distance" | "duration")[];
  mode: "all" | "any";
  weight: "required" | "optional";
}

// A deliberate copy of RULES: the point is that changing the table changes
// behaviour, and behaviour is what these tests read.
const SPEC: Record<string, Spec> = {
  load_reps: { needs: ["reps"], mode: "all", weight: "required" },
  reps: { needs: ["reps"], mode: "all", weight: "optional" },
  distance: { needs: ["distance"], mode: "all", weight: "optional" },
  duration: { needs: ["duration"], mode: "all", weight: "optional" },
  distance_duration: {
    needs: ["distance", "duration"],
    mode: "any",
    weight: "optional",
  },
};

const FIELDS = ["reps", "distance", "duration"] as const;

function setOf(
  fields: readonly string[],
  weightKg: number | null,
): SetMeasures {
  return {
    weightKg,
    reps: fields.includes("reps") ? 8 : null,
    distanceM: fields.includes("distance") ? 100 : null,
    durationS: fields.includes("duration") ? 30 : null,
  };
}

function refused(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    assert(e instanceof ApiError && e.status === 422);
    return true;
  }
}

Deno.test("every combination of fields is judged by the rule table", () => {
  // For each measure and each of the 16 field/weight combinations: an empty
  // side always passes (a planned or retro-logged row), a foreign field is
  // always refused, and otherwise the needs list decides under its own mode.
  // Exhaustive rather than sampled — the space is only 5 × 16 per side.
  for (const measure of MEASURES) {
    const spec = SPEC[measure];
    for (const side of ["target", "actual"] as const) {
      for (let bits = 0; bits < 8; bits++) {
        const fields = FIELDS.filter((_, i) => bits & (1 << i));
        for (const weightKg of [null, 60]) {
          const v = setOf(fields, weightKg);
          const empty = fields.length === 0 && weightKg === null;
          const foreign = fields.some((f) => !spec.needs.includes(f));
          const present = spec.needs.filter((f) => fields.includes(f));
          const enough = spec.mode === "all"
            ? present.length === spec.needs.length
            : present.length > 0;
          const missingWeight = spec.weight === "required" && weightKg === null;
          const ok = empty || (!foreign && enough && !missingWeight);
          assertEquals(
            refused(() => assertSetMeasures(measure, "Test", side, v)),
            !ok,
            `${measure} ${side} [${fields}] weight=${weightKg}`,
          );
        }
      }
    }
  }
});

Deno.test("an unknown measure is refused, never guessed at", () => {
  // Including the object-prototype names: RULES is a plain object, and a
  // bare index once answered "toString" with Object.prototype.toString —
  // a truthy non-rule that turned the refusal into a TypeError.
  const unknown = fc.oneof(
    fc.string(),
    fc.constantFrom("toString", "hasOwnProperty", "constructor", "__proto__"),
  );
  fc.assert(fc.property(unknown, (m) => {
    fc.pre(!(MEASURES as readonly string[]).includes(m));
    assert(
      refused(() =>
        assertSetMeasures(m, "Test", "actual", setOf(["reps"], null))
      ),
      m,
    );
    // The dose-unit view of the same table must not crash on it either.
    assertEquals(doseUnitsFor(m), ["sets"]);
  }));
});

Deno.test("dose units and set fields are one table seen twice", () => {
  // assertDoseUnit must accept exactly what doseUnitsFor lists, and the list
  // must be sets always, minutes iff the measure records duration, km iff it
  // records distance. Two functions, one truth.
  for (const measure of MEASURES) {
    const units = doseUnitsFor(measure);
    assert(units.includes("sets"));
    assertEquals(
      units.includes("minutes"),
      SPEC[measure].needs.includes("duration"),
    );
    assertEquals(
      units.includes("km"),
      SPEC[measure].needs.includes("distance"),
    );
    for (const unit of DOSE_UNITS) {
      assertEquals(
        refused(() => assertDoseUnit(measure, unit, "Test")),
        !units.includes(unit),
        `${measure} in ${unit}`,
      );
    }
  }
});

Deno.test("delivered work adds up", () => {
  // Weekly volume is a sum of per-set conversions, which is only legitimate
  // if the conversion itself is additive — and exact on the unit boundaries:
  // 1000 m is 1 km, 60 s is 1 minute, a null contributes nothing.
  const amount = fc.option(
    fc.double({ min: 0, max: 10_000, noNaN: true }),
    { nil: null },
  );
  fc.assert(
    fc.property(
      fc.constantFrom(...DOSE_UNITS),
      amount,
      amount,
      amount,
      amount,
      amount,
      amount,
      (unit, s1, d1, t1, s2, d2, t2) => {
        const whole = deliveredInDoseUnit(
          unit,
          (s1 ?? 0) + (s2 ?? 0),
          (d1 ?? 0) + (d2 ?? 0),
          (t1 ?? 0) + (t2 ?? 0),
        );
        const parts = deliveredInDoseUnit(unit, s1, d1, t1) +
          deliveredInDoseUnit(unit, s2, d2, t2);
        assertAlmostEquals(whole, parts, 1e-9);
      },
    ),
  );
  assertEquals(deliveredInDoseUnit("km", null, 1000, null), 1);
  assertEquals(deliveredInDoseUnit("minutes", null, null, 60), 1);
  assertEquals(deliveredInDoseUnit("sets", null, null, null), 0);
  assertEquals(deliveredInDoseUnit("km", 5, null, null), 0);
});
