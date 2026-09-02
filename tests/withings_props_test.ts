import { assertAlmostEquals, assertEquals } from "@std/assert";
import fc from "fast-check";
import { selectWeights } from "../api/body/withings_client.ts";
import type { MeasureGroup } from "../api/body/withings_client.ts";

// What selectWeights must guarantee for the sync to be safe to repeat.
// withings_test.ts covers the protocol; these are the selection's laws.

const measure = fc.record({
  value: fc.integer({ min: 1, max: 200_000 }),
  type: fc.constantFrom(1, 4, 5, 6),
  unit: fc.integer({ min: -4, max: 1 }),
});

const group: fc.Arbitrary<MeasureGroup> = fc.record({
  grpid: fc.integer({ min: 1 }),
  date: fc.integer({ min: 0, max: 4_000_000_000 }),
  attrib: fc.constantFrom(0, 2),
  category: fc.constantFrom(1, 2),
  deviceid: fc.option(fc.string({ maxLength: 12 }), { nil: null }),
  measures: fc.array(measure, { maxLength: 4 }),
});

Deno.test("selectWeights partitions: every group is accepted or named", () => {
  // Nothing is dropped in silence — a group either becomes a reading or
  // appears in skipped with a reason. The sync's audit trail depends on the
  // two halves summing to what arrived.
  fc.assert(fc.property(fc.array(group, { maxLength: 30 }), (raw) => {
    // Group ids are unique on Withings' side; the generator does not know
    // that, so uniqueness is imposed here rather than asserted around.
    const groups = raw.map((g, i) => ({ ...g, grpid: i + 1 }));
    const { accepted, skipped } = selectWeights(groups);
    assertEquals(accepted.length + skipped.length, groups.length);
    const ids = [
      ...accepted.map((a) => a.grpid),
      ...skipped.map((s) => s.grpid),
    ]
      .sort();
    assertEquals(ids, groups.map((g) => g.grpid).sort());
    // Accepted iff a real measurement carrying a weight.
    for (const g of groups) {
      const isWeighIn = g.category === 1 &&
        g.measures.some((m) => m.type === 1);
      assertEquals(accepted.some((a) => a.grpid === g.grpid), isWeighIn);
    }
  }));
});

Deno.test("a reading is what will be stored: two decimals, exponent honoured", () => {
  // value × 10^unit, rounded to the numeric(5,2) the column would round to
  // anyway. Rounding here is what makes a redelivery compare equal to the
  // stored row — so exact 2-decimal representability is the law, and the
  // same weight written with a shifted exponent must yield the same kg.
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 200_000 }),
      fc.integer({ min: -4, max: 0 }),
      fc.integer({ min: 0, max: 4_000_000_000 }),
      (value, unit, date) => {
        const reading = (v: number, u: number) =>
          selectWeights([{
            grpid: 1,
            date,
            attrib: 0,
            category: 1,
            deviceid: null,
            measures: [{ value: v, type: 1, unit: u }],
          }]).accepted[0];

        const kg = reading(value, unit).valueKg;
        assertEquals(kg, Math.round(kg * 100) / 100); // representable at 2dp
        assertAlmostEquals(kg, value * 10 ** unit, 0.005 + 1e-9);
        // Exponent invariance: 72700 × 10⁻³ names the same weight as
        // 7270 × 10⁻². (Bounded so the shifted value stays an integer.)
        if (value % 10 === 0 && unit < 1) {
          assertEquals(reading(value / 10, unit + 1).valueKg, kg);
        }
        // The instant is the group's epoch seconds, in UTC ISO.
        assertEquals(
          reading(value, unit).measuredAt,
          new Date(date * 1000).toISOString(),
        );
      },
    ),
  );
});
