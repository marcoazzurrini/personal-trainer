import { assert, assertEquals } from "@std/assert";
import {
  api,
  ensureCatalogue,
  lastMonday,
  lastTuesday,
  resetTraining,
  seedPlan,
  today,
} from "./helpers.ts";

// The counting rules are where silent wrongness would corrupt coaching.
// Scenario: a mesocycle started last Monday (so today is week 2) with a
// squat (quads/adductors direct, glutes indirect, hamstrings excluded), a
// dual-direct lift (quads AND glutes at 1.0), and a power exercise. Last
// week (finished): a retro session. This week: one set today.
Deno.test("counting rules", async (t) => {
  await resetTraining();
  await ensureCatalogue();

  await t.step(
    "empty state routes to onboarding, then programming",
    async () => {
      const empty = await api.get("/training-state");
      assertEquals(empty.body.mesocycles, []);
      assert(empty.body.note.includes("tasks/onboarding"));

      await api.post("/user-context", {
        topic: "goal",
        content: "hypertrophy",
      });
      const known = await api.get("/training-state");
      assert(known.body.note.includes("tasks/programming"));
    },
  );

  await seedPlan({
    name: "Counting meso",
    intent: "Testing the counters.",
    sessions_per_week: 2,
    exercises: [
      { exercise: "squat", weekly_dose: 6 },
      { exercise: "deficit split squat", role: "accessory", weekly_dose: 4 },
      { exercise: "box jumps", role: "accessory", weekly_dose: 3 },
    ],
  });

  // Last week, retro-logged: a performed warmup (excluded), two working
  // squat sets, one dual-count split squat set, one power set (excluded).
  await api.post("/sessions", {
    date: lastTuesday(),
    rationale: "retro for counting",
    sets: [
      { exercise: "squat", kind: "warmup", weight_kg: 60, reps: 5 },
      { exercise: "squat", weight_kg: 100, reps: 6, effort: "hard" },
      { exercise: "squat", weight_kg: 100, reps: 6, effort: "hard" },
      {
        exercise: "deficit split squat",
        weight_kg: 40,
        reps: 10,
        effort: "hard",
      },
      { exercise: "box jumps", reps: 5, effort: "easy" }, // measured in reps
    ],
  });

  // Today, current (unfinished) week: one performed working set.
  await api.post("/sessions", {
    date: today(),
    rationale: "current week session",
    sets: [{ exercise: "squat", weight_kg: 102.5, reps: 5, effort: "hard" }],
  });

  await t.step(
    "weekly-exercise-sets: finished weeks only, warmups excluded, every stimulus counted",
    async () => {
      const { body } = await api.get("/weekly-exercise-sets");
      const rows = body.weekly_exercise_sets;
      assertEquals(rows.length, 3); // week 1 only, all three exercises
      assert(rows.every((r: { week: number }) => r.week === 1));
      const squat = rows.find(
        (r: { exercise: string }) => r.exercise === "Back Squat",
      );
      assertEquals(squat.sets_done, 2); // warmup not counted
      assertEquals(squat.dose, 6);
      assertEquals(squat.delivered, 2); // in the dose's own unit
      const split = rows.find(
        (r: { exercise: string }) => r.exercise === "Deficit Split Squat",
      );
      assertEquals(split.sets_done, 1);
      // Power work is delivery like any other and appears here. It is excluded
      // from weekly-volume, not from the plan's own adherence: a speed plan
      // whose delivery read zero every week would be unjudgeable.
      const jumps = rows.find(
        (r: { exercise: string }) => r.exercise === "Box Jump",
      );
      assertEquals(jumps.sets_done, 1);
    },
  );

  await t.step(
    "weekly-volume: fractional sums per muscle, never a total, current week absent",
    async () => {
      const { body } = await api.get("/weekly-volume");
      const rows = body.weekly_volume;
      assert(
        rows.every((r: { week_start: string }) =>
          r.week_start === lastMonday()
        ),
      );
      const byMuscle = Object.fromEntries(
        rows.map((r: { muscle: string; working_sets: number }) => [
          r.muscle,
          r.working_sets,
        ]),
      );
      assertEquals(byMuscle.quads, 3); // squat 1.0 × 2 + split squat 1.0
      assertEquals(byMuscle.glutes, 2); // squat 0.5 × 2 + split squat 1.0
      assertEquals(byMuscle.adductors, 2.5); // squat 1.0 × 2 + split squat 0.5
      // Exactly these three: the squat's excluded muscles (hamstrings,
      // lower back at 0) produce no rows, and there is no totals row, ever.
      assertEquals(Object.keys(byMuscle).length, 3);
    },
  );

  await t.step("training-state ties it together", async () => {
    const { body } = await api.get("/training-state");
    assertEquals(body.mesocycles.length, 1);
    const meso = body.mesocycles[0];
    assertEquals(meso.week, 2);
    assertEquals(meso.track, "hypertrophy");
    // The hypertrophy method document exists, so the API names it rather than
    // leaving the coach to find out there isn't one.
    assertEquals(meso.method_doc, "GET /docs/method/hypertrophy");
    assertEquals(meso.method_note, null);

    const squat = meso.exercises.find(
      (e: { exercise: string }) => e.exercise === "Back Squat",
    );
    assertEquals(squat.dose, 6); // the plan's number, from its column
    assertEquals(squat.dose_unit, "sets");
    assertEquals(squat.delivered_this_week, 1);
    assertEquals(squat.days_since_trained, 0);

    const split = meso.exercises.find(
      (e: { exercise: string }) => e.exercise === "Deficit Split Squat",
    );
    assertEquals(split.delivered_this_week, 0);

    assertEquals(meso.this_week.sessions_done, 1);
    assertEquals(meso.recent_weeks.length, 1);
    const week1 = meso.recent_weeks[0];
    assertEquals(week1.week, 1);
    assertEquals(week1.working_sets_planned, undefined); // delivered side only
    assertEquals(week1.working_sets_done, 4); // squat 2, split 1, jumps 1
    assertEquals(week1.sessions_done, 1);

    assertEquals(meso.recent_decisions, []); // present, and empty so far

    const recent = body.recent_sessions[0];
    assertEquals(recent.date, today());
    const topSquat = recent.exercises.find(
      (e: { exercise: string }) => e.exercise === "Back Squat",
    );
    assertEquals(topSquat.top_weight_kg, 102.5);
  });

  await t.step("history returns working sets in date order", async () => {
    const { body } = await api.get("/exercises/squat/history?limit=all");
    assertEquals(body.sets.length, 3); // warmup excluded
    assertEquals(body.sets[0].date, lastTuesday());
    assertEquals(body.sets[2].date, today());
    assertEquals(body.total_sets, 3);
  });

  // The read grows forever otherwise: a main lift passes a few hundred sets in
  // a year, and every set now carries its note. A default would have been a
  // decision nobody makes.
  await t.step("history refuses to guess how much to return", async () => {
    const { status, body } = await api.get("/exercises/squat/history");
    assertEquals(status, 422);
    assert(body.error.includes("limit"));
    assert(
      body.error.includes("all"),
      "the whole-series answer must be offered",
    );

    for (const bad of ["0", "-3", "banana", "1.5"]) {
      const res = await api.get(`/exercises/squat/history?limit=${bad}`);
      assertEquals(res.status, 422, bad);
    }
  });

  await t.step("a limit keeps the recent end, and says so", async () => {
    const { body } = await api.get("/exercises/squat/history?limit=2");
    assertEquals(body.sets.length, 2);
    assertEquals(body.returned, 2);
    // Still chronological, and it is the *latest* two that survive.
    assertEquals(body.sets[1].date, today());
    // What it chose not to read is visible, so 2 is never mistaken for all.
    assertEquals(body.total_sets, 3);
  });

  // The reason notes are here at all: the numbers alone read as a plateau.
  await t.step("a set's note comes back with its numbers", async () => {
    const { body } = await api.get("/exercises/squat/history?limit=all");
    assert(
      body.sets.every((s: Record<string, unknown>) => "notes" in s),
      "every set should carry its note field",
    );
  });
});
