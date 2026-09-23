import { assert, assertEquals } from "@std/assert";
import d1 from "./d1.ts";
import {
  api,
  daysBefore,
  ensureCatalogue,
  lastMonday,
  resetTraining,
  seedPlan,
  thisMonday,
  today,
  uuid,
} from "./helpers.ts";

Deno.test("dose history owns current reads without owning membership", async (t) => {
  await resetTraining();
  await ensureCatalogue();
  const { mesocycleId, mesocycle } = await seedPlan({
    exercises: [{ exercise: "squat", weekly_dose: 9 }],
  });
  const membershipId = mesocycle.exercises[0].id;
  const db = d1();
  const path = `/mesocycles/${mesocycleId}`;
  const decisionPath = `${path}/decisions`;
  const history = async () => [
    ...await db`
    select * from mesocycle_exercise_doses
    where mesocycle_id = ${mesocycleId} order by id`,
  ];
  const dose = (value: number) => ({
    exercise: "squat",
    weekly_dose: value,
    weekly_dose_unit: "sets",
  });
  const assertCurrent = async (value: number | null) => {
    const detail = await api.get(path);
    const state = await api.get("/training-state");
    const active = state.body.mesocycles.find(
      (m: { id: number }) => m.id === mesocycleId,
    );
    assertEquals(
      detail.body.mesocycle.exercises.length,
      value === null ? 0 : 1,
    );
    assertEquals(active.exercises.length, value === null ? 0 : 1);
    if (value !== null) {
      assertEquals(detail.body.mesocycle.exercises[0].weekly_dose, value);
      assertEquals(detail.body.mesocycle.exercises[0].weekly_dose_unit, "sets");
      assertEquals(active.exercises[0].dose, value);
      assertEquals(active.exercises[0].dose_unit, "sets");
    }
  };

  try {
    await t.step(
      "creation stores membership separately from its one dose",
      async () => {
        const columns = await db`
        select name from pragma_table_info('mesocycle_exercises')
        where name in ('weekly_dose', 'weekly_dose_unit')`;
        assertEquals(columns.length, 0);
        assertEquals((await history()).length, 1);
        await assertCurrent(9);
        const logged = await api.post("/sessions", {
          date: lastMonday(),
          rationale: "Record delivery before the dose changes.",
          sets: [{ exercise: "squat", weight_kg: 60, reps: 8, effort: "hard" }],
        });
        assertEquals(logged.status, 201);
      },
    );

    const requestId = uuid();
    let originalDecision: unknown;
    await t.step(
      "redose appends 12 without rewriting the earlier 9",
      async () => {
        const before = await history();
        const result = await api.post(decisionPath, {
          request_id: requestId,
          what_changed: "Squat 9 to 12 sets.",
          why: "Recovering well.",
          redose: [dose(12)],
        });
        assertEquals(result.status, 201);
        originalDecision = result.body.decision;
        const after = await history();
        assertEquals(after.length, 2);
        assertEquals(after[0], before[0]);
        // D1 stores hundredths; the public API still reports 12 sets.
        assertEquals(Number(after[1].weekly_dose), 1200);
        assertEquals(
          after[1].effective_from,
          today(),
        );
        assertEquals(result.body.mesocycle.exercises[0].id, membershipId);
        await assertCurrent(12);
        assertEquals(
          (await api.post("/sessions", {
            date: today(),
            rationale: "Record delivery after the dose changes.",
            sets: [{
              exercise: "squat",
              weight_kg: 60,
              reps: 8,
              effort: "hard",
            }],
          })).status,
          201,
        );
        const weeks = await api.get(
          `/weekly-exercise-sets?mesocycle=${mesocycleId}`,
        );
        assertEquals(
          weeks.body.weekly_exercise_sets.map((w: { dose: number }) => w.dose),
          [9], // Weekly delivery excludes the unfinished current week.
        );
      },
    );

    await t.step(
      "same-day ties use the last append; replay appends nothing",
      async () => {
        const changed = await api.post(decisionPath, {
          what_changed: "Squat 12 to 15 sets.",
          why: "Corrected the prescription.",
          redose: [dose(15)],
        });
        assertEquals(changed.status, 201);
        const before = await history();
        const replay = await api.post(decisionPath, {
          request_id: requestId,
          what_changed: "Squat 9 to 12 sets.",
          why: "Recovering well.",
          redose: [dose(12)],
        });
        assertEquals(replay.status, 200);
        assertEquals(replay.body.decision, originalDecision);
        assertEquals(replay.body.mesocycle.exercises[0].weekly_dose, 15);
        assertEquals(await history(), before);
        await assertCurrent(15);
      },
    );

    await t.step(
      "removal keeps history but forbids redose until readdition",
      async () => {
        const before = await history();
        assertEquals(
          (await api.post(decisionPath, {
            what_changed: "Remove squat.",
            why: "Temporary replacement.",
            remove: ["squat"],
          })).status,
          201,
        );
        assertEquals(await history(), before);
        await assertCurrent(null);
        const removed = await api.post(decisionPath, {
          what_changed: "Redose squat.",
          why: "Not a member.",
          redose: [dose(12)],
        });
        assertEquals(removed.status, 422);
        assert(removed.body.error.includes("not in this mesocycle's plan"));
        assertEquals(await history(), before);
        const weeks = await api.get(
          `/weekly-exercise-sets?mesocycle=${mesocycleId}`,
        );
        assertEquals(weeks.body.weekly_exercise_sets[0].dose, 9);
        const added = await api.post(decisionPath, {
          what_changed: "Readd squat at 6 sets.",
          why: "Ready to resume.",
          add: [{
            ...dose(6),
            role: "rehab",
            priority: 2,
            notes: "Return slowly.",
          }],
        });
        assertEquals(added.status, 201);
        assert(added.body.mesocycle.exercises[0].id !== membershipId);
        assertEquals(added.body.mesocycle.exercises[0].role, "rehab");
        assertEquals(added.body.mesocycle.exercises[0].priority, 2);
        assertEquals(added.body.mesocycle.exercises[0].notes, "Return slowly.");
        assertEquals((await history()).slice(0, before.length), before);
        assertEquals((await history()).length, before.length + 1);
        await assertCurrent(6);
      },
    );

    await t.step("a hold does not manufacture a dose", async () => {
      const before = await history();
      assertEquals(
        (await api.post(decisionPath, {
          what_changed: "Hold.",
          why: "No adjustment needed.",
        })).status,
        201,
      );
      assertEquals(await history(), before);
    });

    await t.step(
      "invalid appended dose rolls back earlier changes and the decision",
      async () => {
        const before = await history();
        const log = await api.get(decisionPath);
        const invalid = await api.post(decisionPath, {
          what_changed: "Invalid second dose.",
          why: "Rollback probe.",
          redose: [dose(12), dose(0)],
        });
        assertEquals(invalid.status, 422);
        assert(
          invalid.body.error.includes("weekly_dose must be greater than 0"),
        );
        assertEquals(await history(), before);
        assertEquals((await api.get(decisionPath)).body, log.body);
        await assertCurrent(6);
      },
    );

    await t.step(
      "decision failure rolls back removal, addition, dose, intent and ending",
      async () => {
        const before = await history();
        const plan = await api.get(path);
        const log = await api.get(decisionPath);
        const failedId = uuid();
        await db.unsafe(
          `create trigger fail_dose_decision before insert on mesocycle_decisions
          for each row when new.request_id = '${failedId}'
          begin select raise(abort, 'CHECK constraint failed: injected decision failure'); end`,
        );
        const body = {
          request_id: failedId,
          what_changed: "Replace squat and update plan.",
          why: "Rollback probe.",
          remove: ["squat"],
          add: [{
            exercise: "bench",
            weekly_dose: 8,
            weekly_dose_unit: "sets",
            role: "main",
            priority: 1,
          }],
          redose: [{
            exercise: "bench",
            weekly_dose: 12,
            weekly_dose_unit: "sets",
          }],
          intent: "Changed intent.",
          ended_on: today(),
        };
        try {
          assertEquals((await api.post(decisionPath, body)).status, 422);
          assertEquals(await history(), before);
          assertEquals((await api.get(path)).body, plan.body);
          assertEquals((await api.get(decisionPath)).body, log.body);
        } finally {
          await db`drop trigger fail_dose_decision`;
        }
        // A failed call did not spend its request_id.
        assertEquals((await api.post(decisionPath, body)).status, 201);
        assertEquals((await history()).length, before.length + 2);
        assertEquals((await api.post(decisionPath, body)).status, 200);
        assertEquals((await history()).length, before.length + 2);
      },
    );
  } finally {
    await db.end();
  }
});

Deno.test("future plans expose their starting dose and pre-start decisions", async () => {
  await resetTraining();
  await ensureCatalogue();
  const start = daysBefore(thisMonday(), -14);
  const { mesocycleId, mesocycle } = await seedPlan({
    started_on: start,
    exercises: [{ exercise: "squat", weekly_dose: 9 }],
  });
  assertEquals(mesocycle.week, null);
  assertEquals(mesocycle.exercises[0].weekly_dose, 9);
  const changed = await api.post(`/mesocycles/${mesocycleId}/decisions`, {
    what_changed: "Adjust starting dose.",
    why: "Plan not started.",
    redose: [{ exercise: "squat", weekly_dose: 12, weekly_dose_unit: "sets" }],
    add: [{
      exercise: "bench",
      role: "accessory",
      priority: 2,
      weekly_dose: 6,
      weekly_dose_unit: "sets",
    }],
  });
  assertEquals(changed.status, 201);
  assertEquals(changed.body.mesocycle.exercises[0].weekly_dose, 12);
  const state = await api.get("/training-state");
  assertEquals(
    state.body.mesocycles[0].exercises.map((e: { dose: number }) => e.dose),
    [12, 6],
  );
  const db = d1();
  try {
    const rows = await db`select effective_from from mesocycle_exercise_doses
      where mesocycle_id = ${mesocycleId} order by id`;
    assertEquals(rows.map((r) => r.effective_from), [start, start, start]);
    assertEquals(
      mesocycle.exercises[0].exercise_id,
      changed.body.mesocycle.exercises[0].exercise_id,
    );
  } finally {
    await db.end();
  }
});
