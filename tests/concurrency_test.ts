import { assert, assertEquals } from "@std/assert";
import {
  api,
  daysAgo,
  ensureCatalogue,
  lastMonday,
  resetNutrition,
  resetTraining,
  today,
  uuid,
} from "./helpers.ts";

// The race-shaped invariants, actually raced. Every one of these rules —
// request_id dedupe, one active plan per track, the bodyweight natural key —
// was asserted only sequentially: first call, then second call. But their
// reason to exist is the retry that arrives while the original is still in
// flight, so here both requests leave at once and the database's answer is
// checked afterwards. The statuses may land either way round; what must
// never happen is two rows.

Deno.test("a retry racing its original still writes one food", async () => {
  await resetNutrition();
  const body = {
    name: "Raced Yogurt",
    kcal_100g: 60,
    protein_100g: 10,
    carbs_100g: 4,
    fat_100g: 0.2,
    source: "estimate",
    source_note: "race fixture",
    request_id: uuid(),
  };
  const [a, b] = await Promise.all([
    api.post("/foods", body),
    api.post("/foods", body),
  ]);
  // One of them created it; the other saw the ledger or the name collision.
  // Any of those answers is honest — a second row would not be.
  assert([a.status, b.status].some((s) => s === 200 || s === 201));
  assert([a.status, b.status].every((s) => [200, 201, 409].includes(s)));
  const { body: list } = await api.get("/foods");
  assertEquals(
    list.foods.filter((f: { name: string }) => f.name === "Raced Yogurt")
      .length,
    1,
  );
});

Deno.test("two plans racing for one track leave one plan", async () => {
  await resetTraining();
  await ensureCatalogue();
  const block = await api.post("/blocks", {
    name: "Race block",
    goal: "testing",
    started_on: lastMonday(),
  });
  assertEquals(block.status, 201);

  const plan = (name: string) => ({
    request_id: uuid(), // two genuine attempts, not one retried
    block_id: block.body.block.id,
    name,
    track: "hypertrophy",
    intent: "Hypertrophy. Double progression 6-10; smallest jump 5 kg. " +
      "Rethink if two weeks land under 70% of dose.",
    planned_weeks: 4,
    sessions_per_week: 3,
    started_on: lastMonday(),
    exercises: [{
      exercise: "squat",
      role: "main",
      priority: 1,
      weekly_dose: 10,
      weekly_dose_unit: "sets",
      notes: "6-10 reps",
    }],
  });
  const [a, b] = await Promise.all([
    api.post("/mesocycles", plan("First past the post")),
    api.post("/mesocycles", plan("Beaten to it")),
  ]);
  // The partial unique index is the arbiter: exactly one wins, and the
  // loser is told a mesocycle is already active, not left half-written.
  assertEquals([a.status, b.status].sort(), [201, 409]);
  const current = await api.get("/mesocycles/current");
  assertEquals(current.status, 200);
  const winner = a.status === 201 ? a : b;
  assertEquals(current.body.mesocycle.id, winner.body.mesocycle.id);
});

Deno.test("a session retry racing its original writes one session", async () => {
  await resetTraining();
  await ensureCatalogue();
  const body = {
    request_id: uuid(),
    date: today(),
    rationale: "raced retry",
    sets: [{
      exercise: "squat",
      kind: "working",
      target_weight_kg: 100,
      target_reps: 8,
    }],
  };
  const [a, b] = await Promise.all([
    api.post("/sessions", body),
    api.post("/sessions", body),
  ]);
  assert([a.status, b.status].some((s) => s === 200 || s === 201));
  const { body: list } = await api.get("/sessions?limit=100");
  assertEquals(list.sessions.length, 1);
});

Deno.test("one weigh-in arriving twice at once is one row", async (t) => {
  await resetNutrition();
  // Yesterday's morning, not today's. 05:30Z is 07:30 in Rome, so on today's
  // date it is still ahead of any run started before breakfast, and a
  // measurement in the future is refused — which failed this race as a 422
  // rather than the collision it means to check.
  const instant = `${daysAgo(1)}T05:30:00Z`;

  await t.step("the same value lands as create plus dedupe", async () => {
    const body = { value_kg: 82.4, measured_at: instant };
    const [a, b] = await Promise.all([
      api.post("/bodyweight", body),
      api.post("/bodyweight", body),
    ]);
    assertEquals([a.status, b.status].sort(), [200, 201]);
  });

  await t.step("a different value for the instant loses, once", async () => {
    const [a, b] = await Promise.all([
      api.post("/bodyweight", { value_kg: 83.0, measured_at: instant }),
      api.post("/bodyweight", { value_kg: 83.1, measured_at: instant }),
    ]);
    // 82.4 already holds the instant: both conflicting values are refused.
    assertEquals([a.status, b.status], [409, 409]);
    const { body } = await api.get("/bodyweight");
    const rows = body.bodyweight.filter(
      (r: { measured_at: string }) =>
        new Date(r.measured_at).getTime() === new Date(instant).getTime(),
    );
    assertEquals(rows.length, 1);
    assertEquals(Number(rows[0].value_kg), 82.4);
  });
});
