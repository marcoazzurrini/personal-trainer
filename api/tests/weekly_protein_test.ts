import { assert, assertEquals } from "@std/assert";
import {
  api,
  daysBefore,
  lastFinishedSunday,
  resetNutrition,
  uuid,
} from "./helpers.ts";

Deno.test("weekly protein preserves unknown entries and its actual denominator", async (t) => {
  const sunday = lastFinishedSunday();
  const log = (ago: number, protein: number | null) =>
    api.post("/intake", {
      day: daysBefore(sunday, ago),
      adhoc_kcal: 1000,
      ...(protein === null ? {} : { adhoc_protein_g: protein }),
      request_id: uuid(),
    });
  for (
    const kind of [
      "missing",
      "known",
      "zero",
      "unknown",
      "partial",
      "mixed",
    ] as const
  ) {
    await t.step(kind, async () => {
      await resetNutrition();
      if (kind === "mixed") {
        for (
          const [day, protein] of [[0, 100], [0, null], [1, null], [2, 0], [
            4,
            200,
          ], [4, null]] as const
        ) {
          assertEquals((await log(day, protein)).status, 201);
        }
        for (const ago of [4, 5]) {
          assertEquals(
            (await api.post(`/days/${daysBefore(sunday, ago)}/flags`, {
              flag: "incomplete",
            })).status,
            201,
          );
        }
      } else if (kind !== "missing") {
        for (let day = 0; day < 7; day++) {
          assertEquals(
            (await log(
              day,
              kind === "unknown" ? null : kind === "zero" ? 0 : 100,
            )).status,
            201,
          );
          if (kind === "partial") {
            assertEquals((await log(day, null)).status, 201);
          }
        }
      }
      const response = await api.get("/nutrition/weekly?weeks=1");
      assertEquals(response.status, 200); // helper also validates generated schema
      const week = response.body.weeks[0];
      const expected = {
        missing: [null, 0, 0, 0, 0, 0],
        known: [100, 7, 7, 0, 7, 0],
        zero: [0, 7, 7, 0, 7, 0],
        unknown: [null, 0, 7, 7, 7, 0],
        partial: [100, 7, 14, 7, 7, 0],
        mixed: [50, 2, 4, 2, 4, 2],
      }[kind];
      const coverage = week.protein_coverage;
      assertEquals([
        week.mean_protein_g,
        coverage.days_in_mean,
        coverage.entries,
        coverage.unknown_entries,
        week.days_logged,
        week.days_flagged,
      ], expected);
    });
  }
  for (const task of ["charts", "nutrition-checkin"]) {
    const text = await Deno.readTextFile(
      `plugin/skills/personal-trainer/tasks/${task}.md`,
    );
    for (
      const term of [
        "protein_coverage",
        "days_in_mean",
        "unknown_entries",
        "known-protein floor",
        "shortfall",
      ]
    ) assert(text.includes(term));
  }
});
