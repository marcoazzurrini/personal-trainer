import { assert, assertEquals } from "@std/assert";
import {
  api,
  ensureCatalogue,
  lastMonday,
  lastTuesday,
  resetTraining,
  today,
  uuid,
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
      assertEquals(empty.body.mesocycle, null);
      assert(empty.body.note.includes("tasks/onboarding"));

      await api.post("/user-context", {
        topic: "goal",
        content: "hypertrophy",
      });
      const known = await api.get("/training-state");
      assert(known.body.note.includes("tasks/programming"));
    },
  );

  const block = await api.post("/blocks", {
    name: "Counting block",
    goal: "testing",
    started_on: lastMonday(),
  });
  await api.post("/mesocycles", {
    request_id: uuid(),
    block_id: block.body.block.id,
    name: "Counting meso",
    intent:
      "Testing the counters. Weekly dose: squat 6 then 8, split squat 4, box jumps 3.",
    planned_weeks: 4,
    sessions_per_week: 2,
    started_on: lastMonday(),
    exercises: [
      { exercise: "squat", role: "main", priority: 1 },
      { exercise: "deficit split squat", role: "accessory", priority: 2 },
      { exercise: "box jumps", role: "accessory", priority: 3 },
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
      { exercise: "box jumps", weight_kg: 0, reps: 5, effort: "easy" },
    ],
  });

  // Today, current (unfinished) week: one performed working set.
  await api.post("/sessions", {
    date: today(),
    rationale: "current week session",
    sets: [{ exercise: "squat", weight_kg: 102.5, reps: 5, effort: "hard" }],
  });

  await t.step(
    "weekly-exercise-sets: finished weeks only, warmups and power excluded",
    async () => {
      const { body } = await api.get("/weekly-exercise-sets");
      const rows = body.weekly_exercise_sets;
      assertEquals(rows.length, 2); // week 1 only, two strength exercises
      assert(rows.every((r: { week: number }) => r.week === 1));
      const squat = rows.find(
        (r: { exercise: string }) => r.exercise === "Back Squat",
      );
      assertEquals(squat.sets_done, 2); // warmup not counted
      const split = rows.find(
        (r: { exercise: string }) => r.exercise === "Deficit Split Squat",
      );
      assertEquals(split.sets_done, 1);
      assert(
        !rows.some((r: { exercise: string }) => r.exercise === "Box Jump"),
      );
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
    assertEquals(body.mesocycle.week, 2);
    assert(body.mesocycle.intent.includes("Weekly dose")); // the plan is here

    const squat = body.exercises.find(
      (e: { exercise: string }) => e.exercise === "Back Squat",
    );
    assertEquals(squat.planned_sets_this_week, undefined); // no planned numbers
    assertEquals(squat.sets_done_this_week, 1);
    assertEquals(squat.days_since_trained, 0);

    const split = body.exercises.find(
      (e: { exercise: string }) => e.exercise === "Deficit Split Squat",
    );
    assertEquals(split.sets_done_this_week, 0);

    assertEquals(body.this_week.sessions_done, 1);
    assertEquals(body.recent_weeks.length, 1);
    const week1 = body.recent_weeks[0];
    assertEquals(week1.week, 1);
    assertEquals(week1.working_sets_planned, undefined); // delivered side only
    assertEquals(week1.working_sets_done, 3);
    assertEquals(week1.sessions_done, 1);

    assertEquals(body.recent_decisions, []); // present, and empty so far

    const recent = body.recent_sessions[0];
    assertEquals(recent.date, today());
    const topSquat = recent.exercises.find(
      (e: { exercise: string }) => e.exercise === "Back Squat",
    );
    assertEquals(topSquat.top_weight_kg, 102.5);
  });

  await t.step("history returns working sets in date order", async () => {
    const { body } = await api.get("/exercises/squat/history");
    assertEquals(body.sets.length, 3); // warmup excluded
    assertEquals(body.sets[0].date, lastTuesday());
    assertEquals(body.sets[2].date, today());
  });
});
