import { assert, assertEquals } from "@std/assert";
import {
  api,
  daysBefore,
  ensureCatalogue,
  lastMonday,
  lastTuesday,
  resetTraining,
  seedPlan,
  thisMonday,
  today,
  uuid,
} from "./helpers.ts";

// Two lines of training at once. The thing that has to hold is attribution:
// one afternoon's work serving two plans, each plan judged against its own
// dose in its own unit, and nothing ever counted for the wrong one.
Deno.test("two plans running side by side", async (t) => {
  await resetTraining();
  await ensureCatalogue();

  const { blockId, mesocycleId: hypId, mesocycle: hypMeso } = await seedPlan({
    name: "Hyp",
    intent: "Grow. Double progression.",
    planned_weeks: 5,
    exercises: [
      { exercise: "squat", weekly_dose: 9 },
      {
        exercise: "band face pull",
        role: "rehab",
        priority: 9,
        weekly_dose: 6,
        notes: "shoulder",
      },
    ],
  });

  const { mesocycleId: speedId } = await seedPlan({
    blockId,
    name: "Speed",
    track: "speed",
    intent: "Hold top speed. Full recovery.",
    sessions_per_week: 2,
    exercises: [
      { exercise: "sprint", weekly_dose: 0.4, weekly_dose_unit: "km" },
      {
        exercise: "easy run",
        role: "accessory",
        priority: 5,
        weekly_dose: 40,
        weekly_dose_unit: "minutes",
      },
    ],
  });

  await t.step(
    "rehab is a role inside a plan, not a track of its own",
    async () => {
      const bad = await api.post("/mesocycles", {
        block_id: blockId,
        name: "Rehab",
        track: "rehab",
        intent: "shoulder",
        planned_weeks: 4,
        sessions_per_week: 3,
        started_on: lastMonday(),
        exercises: [{
          exercise: "band face pull",
          role: "main",
          priority: 1,
          weekly_dose: 6,
          weekly_dose_unit: "sets",
        }],
      });
      assertEquals(bad.status, 422);
      const facePull = hypMeso.exercises.find(
        (e: { exercise: string }) => e.exercise === "Band Face Pull",
      );
      assertEquals(facePull.role, "rehab");
    },
  );

  await t.step('"current" refuses to guess between them', async () => {
    const { status, body } = await api.get("/mesocycles/current");
    assertEquals(status, 422);
    assert(body.error.includes("ambiguous"), body.error);
    assert(body.error.includes("current:"), body.error);
  });

  await t.step('"current:<track>" names one', async () => {
    const speedNow = await api.get("/mesocycles/current:speed");
    assertEquals(speedNow.body.mesocycle.id, speedId);
    const hypNow = await api.get("/mesocycles/current:hypertrophy");
    assertEquals(hypNow.body.mesocycle.id, hypId);

    const nonsense = await api.get("/mesocycles/current:rowing");
    assertEquals(nonsense.status, 422);
    const absent = await api.get("/mesocycles/current:endurance");
    assertEquals(absent.status, 404);
  });

  // The heart of it: one bout, two plans, and the API works out which is which
  // from the exercise. Nothing in the payload says "mesocycle".
  await t.step("one session serves both plans", async () => {
    const { status, body } = await api.post("/sessions", {
      date: today(),
      rationale: "Speed first while fresh, squats after.",
      sets: [
        { exercise: "sprint", distance_m: 40, duration_s: 5.21 },
        { exercise: "sprint", distance_m: 40, duration_s: 5.28 },
        { exercise: "squat", weight_kg: 100, reps: 5, effort: "hard" },
      ],
    });
    assertEquals(status, 201);
    const byExercise = Object.fromEntries(
      body.session.sets.map((
        s: { exercise: string; mesocycle_id: number },
      ) => [s.exercise, s.mesocycle_id]),
    );
    assertEquals(byExercise["Sprint"], speedId);
    assertEquals(byExercise["Back Squat"], hypId);
  });

  await t.step("work in no plan is off-plan, not misfiled", async () => {
    const { body } = await api.post("/sessions", {
      date: today(),
      rationale: "kickabout",
      sets: [{ exercise: "broad jump", distance_m: 240 }],
    });
    assertEquals(body.session.sets[0].mesocycle_id, null);
  });

  await t.step("each plan sees only its own delivery", async () => {
    const { body } = await api.get("/training-state");
    assertEquals(body.mesocycles.length, 2);

    const speedState = body.mesocycles.find(
      (m: { track: string }) => m.track === "speed",
    );
    const sprint = speedState.exercises.find(
      (e: { exercise: string }) => e.exercise === "Sprint",
    );
    // 80 m delivered against a dose stated in km, expressed in km.
    assertEquals(sprint.delivered_this_week, 0.08);
    assertEquals(sprint.dose, 0.4);
    assertEquals(sprint.dose_unit, "km");

    const hypState = body.mesocycles.find(
      (m: { track: string }) => m.track === "hypertrophy",
    );
    const squat = hypState.exercises.find(
      (e: { exercise: string }) => e.exercise === "Back Squat",
    );
    assertEquals(squat.delivered_this_week, 1);
    // The sprints are not in this plan's exercise list at all, so they cannot
    // leak into it however the sessions were arranged.
    assertEquals(hypState.exercises.length, 2);

    // Weeks are numbered from each plan's own Monday, so they are labelled
    // per plan rather than once for the conversation.
    assert(speedState.week !== undefined && hypState.week !== undefined);
  });

  await t.step(
    "a session counted once serves both plans' filters",
    async () => {
      const speedSessions = await api.get("/sessions?mesocycle=current:speed");
      const hypSessions = await api.get(
        "/sessions?mesocycle=current:hypertrophy",
      );
      const speedIds = speedSessions.body.sessions.map((s: { id: number }) =>
        s.id
      );
      const hypIds = hypSessions.body.sessions.map((s: { id: number }) => s.id);
      // The mixed session appears under both; the kickabout under neither.
      assertEquals(
        speedIds.filter((id: number) => hypIds.includes(id)).length,
        1,
      );
    },
  );

  await t.step("sprint work never reaches muscle volume", async () => {
    // A finished week holding both kinds of work, so the view has something to
    // include and something to leave out. Sprints are a conditioning stimulus:
    // they are real delivery against the speed plan's dose and must never
    // appear as sets against a muscle.
    await api.post("/sessions", {
      date: lastTuesday(),
      rationale: "last week: sprints and squats",
      sets: [
        { exercise: "sprint", distance_m: 40, duration_s: 5.3 },
        { exercise: "squat", weight_kg: 100, reps: 5, effort: "hard" },
      ],
    });

    const { body } = await api.get(
      "/weekly-volume?mesocycle=current:hypertrophy",
    );
    const byMuscle = Object.fromEntries(
      body.weekly_volume.map((
        r: { muscle: string; working_sets: number },
      ) => [r.muscle, r.working_sets]),
    );
    // Exactly the squat's muscles, at the squat's factors, from one set.
    assertEquals(byMuscle, { quads: 1, adductors: 1, glutes: 0.5 });

    // The same week, read as delivery, does count the sprint.
    const speedWeek = await api.get(
      "/weekly-exercise-sets?mesocycle=current:speed",
    );
    const sprint = speedWeek.body.weekly_exercise_sets.find(
      (r: { exercise: string }) => r.exercise === "Sprint",
    );
    assertEquals(sprint.distance_m, 40);
    assertEquals(sprint.delivered, 0.04); // km, the dose's unit
  });

  await t.step(
    "off-plan lifting never bleeds into a plan's volume",
    async () => {
      // Benching with a friend, in no plan, in the same finished week as the
      // hypertrophy plan's squats. The read once filtered by date range, so
      // this session's chest sets would have landed in the hypertrophy
      // numbers — attributed rows are the fix, and this is the bleed test.
      await api.post("/sessions", {
        date: lastTuesday(),
        rationale: "gym with a friend, off-plan bench",
        sets: [
          { exercise: "bench press", weight_kg: 80, reps: 8, effort: "hard" },
        ],
      });

      const hyp = await api.get("/weekly-volume?mesocycle=current:hypertrophy");
      const muscles = hyp.body.weekly_volume.map(
        (r: { muscle: string }) => r.muscle,
      );
      assert(
        !muscles.includes("chest"),
        `the off-plan bench leaked into the plan: ${muscles}`,
      );

      // The long view still counts it: a muscle does not care which plan
      // loaded it, and ?all is about the muscle.
      const all = await api.get("/weekly-volume?mesocycle=all");
      const chest = all.body.weekly_volume.find(
        (r: { muscle: string }) => r.muscle === "chest",
      );
      assert(chest, "off-plan work belongs in the long view");
      assertEquals(chest.working_sets, 1);
    },
  );

  await t.step("a redose does not rewrite past weeks", async () => {
    // Week 1 delivered its squat against a dose of 9. The redose is the
    // plan's current truth from today — but a dose history row is written
    // with it, and the delivery read joins the dose in force at each week's
    // end. Before the history existed this read showed 12 against every
    // week, and the only record of the 9 was prose in the decision log.
    const revision = await api.post(`/mesocycles/${hypId}/revisions`, {
      decision: { what_changed: "squat 9 -> 12 sets", why: "recovering well" },
      redose: [
        { exercise: "squat", weekly_dose: 12, weekly_dose_unit: "sets" },
      ],
    });
    assertEquals(revision.status, 200);

    const { body } = await api.get(`/weekly-exercise-sets?mesocycle=${hypId}`);
    const week1 = body.weekly_exercise_sets.find(
      (r: { exercise: string; week: number }) =>
        r.exercise === "Back Squat" && r.week === 1,
    );
    assertEquals(week1.dose, 9, "the dose week 1 was actually judged against");

    // The plan itself carries the new current dose — the history changes
    // what past weeks report, never what the plan asks for now.
    const plan = await api.get(`/mesocycles/${hypId}`);
    const squat = plan.body.mesocycle.exercises.find(
      (e: { exercise: string }) => e.exercise === "Back Squat",
    );
    assertEquals(squat.weekly_dose, 12);
  });

  await t.step(
    "the week's shape is a row, and rewriting replaces it",
    async () => {
      const first = await api.post("/week-schedule", {
        schedule: "Mon lift, Tue sprint, Thu lift",
      });
      assertEquals(first.status, 201);
      assertEquals(first.body.week_schedule.week_start, thisMonday());
      // The resolved week is echoed in full: on a weekend, "this Monday" is
      // six days in the past and the write lands on the week now ending — the
      // echo (and, on Sat/Sun, an explicit note) is what lets a coach catch a
      // schedule filed under the wrong week in the same breath as writing it.
      assertEquals(
        first.body.week_schedule.week_end,
        daysBefore(thisMonday(), -6),
      );
      const dow = new Date(`${today()}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) {
        assert(
          first.body.note.includes("week now ending"),
          `a weekend default deserves a warning: ${JSON.stringify(first.body)}`,
        );
      } else {
        assertEquals(first.body.note ?? null, null);
      }

      const second = await api.post("/week-schedule", {
        schedule: "Mon lift, Tue sprint, Thu lift, Sat sprint + easy run",
      });
      assertEquals(second.status, 201);

      const { body } = await api.get("/training-state");
      assert(body.week_schedule.schedule.includes("Sat sprint"));
      assert(!body.week_schedule.schedule.endsWith("Thu lift"));
    },
  );

  await t.step(
    "a schedule for a week that is not a Monday is refused",
    async () => {
      const { status, body } = await api.post("/week-schedule", {
        week_start: lastTuesday(),
        schedule: "nope",
      });
      assertEquals(status, 422);
      assert(body.error.includes("Monday"), body.error);
    },
  );

  await t.step("ending one plan leaves the other running", async () => {
    await api.patch(`/mesocycles/${speedId}`, { ended_on: today() });
    const { status, body } = await api.get("/mesocycles/current");
    assertEquals(status, 200); // no longer ambiguous
    assertEquals(body.mesocycle.id, hypId);

    // And the track is free again, which is what ending it is for.
    const again = await api.post("/mesocycles", {
      block_id: blockId,
      name: "Speed 2",
      track: "speed",
      intent: "next speed block",
      planned_weeks: 4,
      sessions_per_week: 2,
      started_on: thisMonday(),
      exercises: [{
        exercise: "sprint",
        role: "main",
        priority: 1,
        weekly_dose: 0.5,
        weekly_dose_unit: "km",
      }],
    });
    assertEquals(again.status, 201);
  });
});

// An exercise in two active plans is the one case attribution cannot infer.
// It should never happen — the same lift on two plans splits its own
// progression record — but the guard is what makes the inference safe.
Deno.test("an exercise on two plans is asked about, not guessed", async () => {
  await resetTraining();
  await ensureCatalogue();

  const { blockId } = await seedPlan({
    name: "hypertrophy plan",
    intent: "testing",
    exercises: [{ exercise: "squat", weekly_dose: 6 }],
  });
  await seedPlan({
    blockId,
    name: "strength plan",
    track: "strength",
    intent: "testing",
    exercises: [{ exercise: "squat", weekly_dose: 6 }],
  });

  const ambiguous = await api.post("/sessions", {
    request_id: uuid(),
    date: today(),
    rationale: "which plan?",
    sets: [{ exercise: "squat", weight_kg: 100, reps: 5, effort: "hard" }],
  });
  assertEquals(ambiguous.status, 422);
  assert(ambiguous.body.error.includes("more than one active plan"));
  assert(ambiguous.body.error.includes("mesocycle"));

  // Saying which resolves it — and the whole session was refused before, so
  // nothing was half-written.
  const sessions = await api.get("/sessions?limit=10");
  assertEquals(sessions.body.sessions.length, 0);

  const named = await api.post("/sessions", {
    date: today(),
    rationale: "the strength plan's squats",
    sets: [{
      exercise: "squat",
      mesocycle: "current:strength",
      weight_kg: 100,
      reps: 5,
      effort: "hard",
    }],
  });
  assertEquals(named.status, 201);
  const strength = await api.get("/mesocycles/current:strength");
  assertEquals(
    named.body.session.sets[0].mesocycle_id,
    strength.body.mesocycle.id,
  );
});
