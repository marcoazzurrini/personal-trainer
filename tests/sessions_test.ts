import { assert, assertEquals } from "@std/assert";
import {
  api,
  BASE,
  ensureCatalogue,
  lastMonday,
  lastTuesday,
  resetTraining,
  today,
  uuid,
} from "./helpers.ts";

Deno.test("session lifecycle", async (t) => {
  await resetTraining();
  await ensureCatalogue();

  const block = await api.post("/blocks", {
    name: "Test block",
    goal: "testing",
    started_on: lastMonday(),
  });
  await api.post("/mesocycles", {
    block_id: block.body.block.id,
    name: "Meso",
    track: "hypertrophy",
    intent: "testing",
    planned_weeks: 4,
    sessions_per_week: 3,
    started_on: lastMonday(),
    exercises: [{
      exercise: "squat",
      role: "main",
      priority: 1,
      weekly_dose: 9,
      weekly_dose_unit: "sets",
    }],
  });

  const requestId = uuid();
  let sessionId: number;
  let workingSetId: number;

  await t.step("an upcoming session creates rows with targets", async () => {
    const { status, body } = await api.post("/sessions", {
      request_id: requestId,
      date: today(),
      rationale: "test session",
      sets: [
        {
          exercise: "squat",
          kind: "warmup",
          target_weight_kg: 60,
          target_reps: 5,
        },
        { exercise: "squat", target_weight_kg: 100, target_reps: 6 },
        { exercise: "squat", target_weight_kg: 100, target_reps: 6 },
      ],
    });
    assertEquals(status, 201);
    sessionId = body.session.id;
    assert(body.session.public_id.length >= 20);
    assertEquals(body.session.sets.length, 3);
    assertEquals(
      body.session.sets.map((s: { position: number }) => s.position),
      [1, 2, 3],
    );
    assertEquals(body.session.sets[1].weight_kg, null); // actuals empty
    workingSetId = body.session.sets[1].id;
  });

  await t.step("a retry with the same request_id is a no-op", async () => {
    const { status, body } = await api.post("/sessions", {
      request_id: requestId,
      date: today(),
      rationale: "test session",
      sets: [{ exercise: "squat", target_weight_kg: 1, target_reps: 1 }],
    });
    assertEquals(status, 200);
    assertEquals(body.session.id, sessionId);
    assertEquals(body.session.sets.length, 3); // original, not the retry body
  });

  await t.step("a new set cannot carry both targets and actuals", async () => {
    const { status, body } = await api.post("/sessions", {
      date: today(),
      rationale: "x",
      sets: [{
        exercise: "squat",
        target_weight_kg: 100,
        target_reps: 5,
        weight_kg: 100,
        reps: 5,
        effort: "hard",
      }],
    });
    assertEquals(status, 422);
    assert(body.error.includes("never both"));
  });

  await t.step("logging a working set without effort is rejected", async () => {
    const { status, body } = await api.patch(`/sets/${workingSetId}`, {
      weight_kg: 100,
      reps: 6,
    });
    assertEquals(status, 422);
    assert(body.error.includes("effort"));
  });

  await t.step(
    "logging with effort works and stamps performed_at",
    async () => {
      const { status, body } = await api.patch(`/sets/${workingSetId}`, {
        weight_kg: 100,
        reps: 6,
        effort: "hard",
      });
      assertEquals(status, 200);
      assertEquals(body.set.weight_kg, 100);
      assert(body.set.performed_at !== null);
    },
  );

  await t.step("resending the same patch is idempotent", async () => {
    const { status, body } = await api.patch(`/sets/${workingSetId}`, {
      weight_kg: 100,
      reps: 6,
      effort: "hard",
    });
    assertEquals(status, 200);
    assertEquals(body.set.reps, 6);
  });

  await t.step("targets are immutable through PATCH", async () => {
    const { status, body } = await api.patch(`/sets/${workingSetId}`, {
      target_weight_kg: 90,
    });
    assertEquals(status, 422);
    assert(body.error.includes("immutable"));
  });

  await t.step("an unplanned set appends at the next position", async () => {
    const { status, body } = await api.post(`/sessions/${sessionId}/sets`, {
      exercise: "squat",
      weight_kg: 100,
      reps: 5,
      effort: "failure",
    });
    assertEquals(status, 201);
    assertEquals(body.set.position, 4);
    assertEquals(body.set.target_weight_kg, undefined); // no targets on unplanned
  });

  await t.step("an unplanned set requires actuals", async () => {
    const { status } = await api.post(`/sessions/${sessionId}/sets`, {
      exercise: "squat",
      target_weight_kg: 100,
      target_reps: 5,
    });
    assertEquals(status, 422);
  });

  await t.step("completing a session is a field change", async () => {
    const { status, body } = await api.patch(`/sessions/${sessionId}`, {
      overall_feel: "solid",
      completed_at: new Date().toISOString(),
    });
    assertEquals(status, 200);
    assert(body.session.completed_at !== null);
  });

  await t.step("a retro session carries actuals and null targets", async () => {
    const { status, body } = await api.post("/sessions", {
      date: lastTuesday(),
      rationale: "retro-logged, forgot to log",
      sets: [
        { exercise: "squat", weight_kg: 95, reps: 8, effort: "hard" },
        { exercise: "squat", weight_kg: 95, reps: 8, effort: "hard" },
      ],
    });
    assertEquals(status, 201);
    assertEquals(body.session.sets[0].target_weight_kg, null);
    assertEquals(body.session.sets[0].weight_kg, 95);
  });

  await t.step("sessions list filters by mesocycle", async () => {
    const { body } = await api.get("/sessions?mesocycle=current&limit=10");
    assertEquals(body.sessions.length, 2);
    assert(!("sets" in body.sessions[0])); // rows only, no sets
  });

  await t.step("a skipped planned set survives as an empty row", async () => {
    const { body } = await api.get(`/sessions/${sessionId}`);
    const skipped = body.session.sets.find(
      (s: { position: number }) => s.position === 3,
    );
    assertEquals(skipped.weight_kg, null);
    assertEquals(skipped.target_weight_kg, 100);
  });
});

Deno.test("a draft session is discardable; a performed one is not", async (t) => {
  await resetTraining();
  await ensureCatalogue();
  // The iteration loop this protects: coach proposes a session, Marco wants
  // it different, coach discards the draft and writes a better one. Before
  // the delete existed the only path was superseding, and the record filled
  // with dead planned sessions precisely because someone cared about the
  // plan. The guard is the other half: one actual, or a started/finished
  // stamp, and the session is history — the delete refuses.
  const plan = () => ({
    date: today(),
    rationale: "draft for the delete tests",
    sets: [
      { exercise: "squat", target_weight_kg: 100, target_reps: 5 },
      { exercise: "squat", target_weight_kg: 100, target_reps: 5 },
    ],
  });

  await t.step("nothing touched: the draft deletes whole", async () => {
    const created = await api.post("/sessions", plan());
    assertEquals(created.status, 201, created.body.error);
    const id = created.body.session.id;
    const publicId = created.body.session.public_id;

    const { status, body } = await api.delete(`/sessions/${id}`);
    assertEquals(status, 200);
    assertEquals(body.deleted.sets, 2);

    assertEquals((await api.get(`/sessions/${id}`)).status, 404);
    // The log page link dies with the draft.
    const page = await fetch(`${BASE}/s/${publicId}`);
    await page.body?.cancel();
    assertEquals(page.status, 404);
  });

  await t.step("one actual on record refuses the delete", async () => {
    const created = await api.post("/sessions", plan());
    const id = created.body.session.id;
    const setId = created.body.session.sets[0].id;
    const logged = await api.patch(`/sets/${setId}`, {
      weight_kg: 100,
      reps: 5,
      effort: "hard",
    });
    assertEquals(logged.status, 200, logged.body.error);

    const { status, body } = await api.delete(`/sessions/${id}`);
    assertEquals(status, 409);
    assert(body.error.includes("1 of its 2 sets"), body.error);
    assert(body.error.includes("PATCH /sets/:id"), body.error);
  });

  await t.step(
    "a started session is history even with no actuals",
    async () => {
      // Starting the workout is commitment enough: the log page was opened, the
      // warmup happened, the plan was the plan. No silent discard after that.
      const created = await api.post("/sessions", plan());
      const id = created.body.session.id;
      await api.patch(`/sessions/${id}`, {
        started_at: new Date().toISOString(),
      });
      const { status, body } = await api.delete(`/sessions/${id}`);
      assertEquals(status, 409);
      assert(body.error.includes("started or finished"), body.error);
    },
  );
});
