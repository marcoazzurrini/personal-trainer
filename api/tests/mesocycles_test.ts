import { assert, assertEquals } from "@std/assert";
import {
  api,
  endPlan,
  ensureCatalogue,
  lastMonday,
  reopenPlan,
  resetTraining,
  today,
  uuid,
} from "./helpers.ts";

// The intent holds the plan's judgment — goals, progression, the
// falsification line. The weekly dose is the one number that left it for a
// column, because the server computes behind-and-ahead from it.
const INTENT = "Hypertrophy. Double progression 6-10; smallest jump 5 kg. " +
  "Rethink if two weeks land under 70% of dose.";

function planBody(requestId: string, blockId: number) {
  return {
    request_id: requestId,
    block_id: blockId,
    name: "Test meso",
    track: "hypertrophy",
    intent: INTENT,
    planned_weeks: 4,
    sessions_per_week: 3,
    started_on: lastMonday(),
    exercises: [
      {
        exercise: "squat",
        role: "main",
        priority: 1,
        weekly_dose: 10,
        weekly_dose_unit: "sets",
        notes: "6-10 reps",
      },
      {
        exercise: "chin ups",
        role: "accessory",
        priority: 2,
        weekly_dose: 6,
        weekly_dose_unit: "sets",
      },
    ],
  };
}

Deno.test("mesocycle lifecycle", async (t) => {
  await resetTraining();
  await ensureCatalogue();

  const block = await api.post("/blocks", {
    name: "Test block",
    goal: "testing",
    started_on: lastMonday(),
  });
  assertEquals(block.status, 201);
  const blockId = block.body.block.id;
  const requestId = uuid();
  let mesoId: number;

  await t.step("creation returns intent and exercise list", async () => {
    const { status, body } = await api.post(
      "/mesocycles",
      planBody(requestId, blockId),
    );
    assertEquals(status, 201);
    mesoId = body.mesocycle.id;
    assertEquals(body.mesocycle.intent, INTENT);
    assertEquals(body.mesocycle.exercises.length, 2);
    const squat = body.mesocycle.exercises[0];
    assertEquals(squat.exercise, "Back Squat"); // alias resolved server-side
    assertEquals(body.mesocycle.track, "hypertrophy");
    assertEquals(squat.weekly_dose, 10); // the dose is structured
    assertEquals(squat.weekly_dose_unit, "sets");
    assertEquals(body.mesocycle.week, 2); // started last Monday
  });

  await t.step(
    "an entry carrying weekly_sets is pointed at weekly_dose",
    async () => {
      await endPlan(mesoId);
      const bad = planBody(uuid(), blockId);
      // deno-lint-ignore no-explicit-any
      (bad.exercises[0] as any).weekly_sets = [{ week: 1, sets: 10 }];
      const { status, body } = await api.post("/mesocycles", bad);
      assertEquals(status, 422);
      assert(body.error.includes("weekly_dose"), body.error);
      await reopenPlan(mesoId);
    },
  );

  await t.step("a retry with the same request_id is a no-op", async () => {
    const { status, body } = await api.post(
      "/mesocycles",
      planBody(requestId, blockId),
    );
    assertEquals(status, 200);
    assertEquals(body.mesocycle.id, mesoId);
  });

  await t.step(
    "a second active mesocycle on the track is impossible",
    async () => {
      const { status, body } = await api.post(
        "/mesocycles",
        { ...planBody(uuid(), blockId), started_on: lastMonday() },
      );
      assertEquals(status, 409);
      assert(body.error.includes("already active on that track"), body.error);
    },
  );

  // The point of tracks: another line of training is not in the way. Ended
  // immediately so the rest of this suite keeps a single active plan and
  // "current" stays unambiguous — the ambiguity itself is tracks_test's job.
  await t.step("a plan on another track runs alongside it", async () => {
    const { status, body } = await api.post("/mesocycles", {
      ...planBody(uuid(), blockId),
      name: "Speed alongside",
      track: "speed",
      exercises: [{
        exercise: "sprint",
        role: "main",
        priority: 1,
        weekly_dose: 0.3,
        weekly_dose_unit: "km",
      }],
    });
    assertEquals(status, 201);
    await endPlan(body.mesocycle.id);
  });

  await t.step("a non-Monday start is rejected", async () => {
    await endPlan(mesoId);
    const tuesday = new Date(`${lastMonday()}T00:00:00Z`);
    tuesday.setUTCDate(tuesday.getUTCDate() + 1);
    const { status, body } = await api.post("/mesocycles", {
      ...planBody(uuid(), blockId),
      started_on: tuesday.toISOString().slice(0, 10),
    });
    assertEquals(status, 422);
    assert(body.error.includes("Monday"));
    // reopen for the rest of the suite
    await reopenPlan(mesoId);
  });

  await t.step("current resolves to the active mesocycle", async () => {
    const { body } = await api.get("/mesocycles/current");
    assertEquals(body.mesocycle.id, mesoId);
  });

  await t.step("the intent cannot be edited casually", async () => {
    const { status, body } = await api.patch(`/mesocycles/${mesoId}`, {
      name: "still fine",
      intent: "new plan, no reason given",
    });
    assertEquals(status, 422);
    assert(body.error.includes("decision"), body.error);
  });

  // The hole this endpoint used to have: ending a plan is the plan change
  // that most needs a reason, and it was the only one that never asked.
  await t.step("a plan cannot be ended without a reason", async () => {
    const { status, body } = await api.patch(`/mesocycles/${mesoId}`, {
      name: "still fine",
      ended_on: today(),
    });
    assertEquals(status, 422);
    assert(body.error.includes("carries its reason"), body.error);
  });

  await t.step("ending a plan records why in the log", async () => {
    const { status, body } = await api.post(
      `/mesocycles/${mesoId}/decisions`,
      {
        ended_on: today(),
        what_changed: "Ended the plan a week early.",
        why: "Shoulder flared up.",
      },
    );
    assertEquals(status, 201);
    assertEquals(body.mesocycle.ended_on, today());
    assertEquals(body.decision.why, "Shoulder flared up.");

    const log = await api.get(`/mesocycles/${mesoId}/decisions`);
    assert(
      log.body.decisions.some(
        (d: { why: string }) => d.why === "Shoulder flared up.",
      ),
    );
    await reopenPlan(mesoId);
  });

  await t.step("an unknown exercise in a plan is a 422", async () => {
    await endPlan(mesoId);
    const bad = planBody(uuid(), blockId);
    bad.exercises[0].exercise = "zercher yoke walk";
    const { status, body } = await api.post("/mesocycles", bad);
    assertEquals(status, 422);
    assert(body.error.includes("Unknown exercise"));
    await reopenPlan(mesoId);
  });

  await t.step("a change without its reason is rejected", async () => {
    const { status, body } = await api.post(
      "/mesocycles/current/decisions",
      { remove: ["chin ups"] },
    );
    assertEquals(status, 422);
    assert(body.error.includes("what_changed"), body.error);
  });

  await t.step("a change with weekly_sets points at redose", async () => {
    const { status, body } = await api.post("/mesocycles/current/decisions", {
      what_changed: "x",
      why: "y",
      weekly_sets: [{ exercise: "squat", week: 3, sets: 15 }],
    });
    assertEquals(status, 422);
    assert(body.error.includes("redose"), body.error);
  });

  // A dose change is a plan change: same call, same mandatory reason.
  await t.step("a dose changes only through a decision", async () => {
    const { status, body } = await api.post("/mesocycles/current/decisions", {
      what_changed: "squat 10 -> 12 sets",
      why: "recovering well",
      redose: [{
        exercise: "squat",
        weekly_dose: 12,
        weekly_dose_unit: "sets",
      }],
    });
    assertEquals(status, 201);
    const squat = body.mesocycle.exercises.find(
      (e: { exercise: string }) => e.exercise === "Back Squat",
    );
    assertEquals(squat.weekly_dose, 12);
  });

  await t.step("redosing an exercise outside the plan is refused", async () => {
    const { status, body } = await api.post("/mesocycles/current/decisions", {
      what_changed: "x",
      why: "y",
      redose: [{ exercise: "bench", weekly_dose: 8, weekly_dose_unit: "sets" }],
    });
    assertEquals(status, 422);
    assert(body.error.includes("not in this mesocycle's plan"), body.error);
  });

  const REVISED_INTENT = INTENT.replace("6-10", "5-8");

  await t.step(
    "a decision swaps exercises and replaces the intent atomically",
    async () => {
      const { status, body } = await api.post("/mesocycles/current/decisions", {
        request_id: uuid(),
        what_changed: "chin ups out, pull ups in; intent updated to match",
        why: "elbow niggle",
        remove: ["chin ups"],
        add: [{
          exercise: "pull ups",
          role: "accessory",
          priority: 2,
          weekly_dose: 6,
          weekly_dose_unit: "sets",
        }],
        intent: REVISED_INTENT,
      });
      assertEquals(status, 201);
      const names = body.mesocycle.exercises.map(
        (e: { exercise: string }) => e.exercise,
      );
      assert(!names.includes("Chin-Up"));
      assert(names.includes("Pull-Up"));
      assertEquals(body.mesocycle.intent, REVISED_INTENT);
    },
  );

  await t.step("the replaced intent survives in the decision log", async () => {
    const { body } = await api.get("/mesocycles/current/decisions");
    const replacement = body.decisions.find(
      (d: { prior_intent: string | null }) => d.prior_intent !== null,
    );
    assertEquals(replacement.prior_intent, INTENT);
  });

  await t.step("removing an exercise not in the plan fails whole", async () => {
    const before = await api.get("/mesocycles/current");
    const { status } = await api.post("/mesocycles/current/decisions", {
      what_changed: "x",
      why: "y",
      remove: ["bench"],
      intent: "should never be written",
    });
    assertEquals(status, 422);
    const after = await api.get("/mesocycles/current");
    assertEquals(after.body.mesocycle, before.body.mesocycle); // nothing applied
  });

  // The 422 that used to guard this was the whole argument for two endpoints:
  // one door refused exactly what the other existed for.
  await t.step("a hold decision is recordable without a change", async () => {
    const { status } = await api.post("/mesocycles/current/decisions", {
      what_changed: "nothing — held the plan",
      why: "reps still climbing",
    });
    assertEquals(status, 201);
    const log = await api.get("/mesocycles/current/decisions");
    const last = log.body.decisions.at(-1);
    assertEquals(last.what_changed, "nothing — held the plan");
    assertEquals(last.prior_intent, null);
  });
});
