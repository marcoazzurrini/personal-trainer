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
