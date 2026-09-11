import { assert, assertEquals } from "@std/assert";
import {
  api,
  ensureCatalogue,
  resetTraining,
  seedPlan,
  today,
  uuid,
} from "./helpers.ts";
import {
  assertIdentity,
  databaseIdentity,
  verifiedDatabase,
} from "./disposable.ts";
import type { SetEntry } from "../training/sessions.ts";

Deno.test("session creation resolves references per request and inserts sets in batches", async (t) => {
  const disposable = await verifiedDatabase();
  await resetTraining();
  await ensureCatalogue();
  const { sql } = await import("../db.ts");
  const previousDebug = sql.options.debug;
  try {
    // Observe the real driver's statements, not a mock or source-code pattern.
    // Verify this process's singleton too: the HTTP server has its own handle.
    assertIdentity(disposable, await databaseIdentity(sql));
    const { writeSession } = await import("../training/sessions.ts");
    const measured = async (sets: SetEntry[], request_id = uuid()) => {
      const statements: string[] = [];
      sql.options.debug = (_connection, query) => {
        const statement = query.trim().replace(/\s+/g, " ");
        if (/^(select|insert|update|delete)\b/i.test(statement)) {
          statements.push(statement);
        }
      };
      try {
        const result = await writeSession({
          date: today(),
          rationale: "Session creation regression fixture",
          request_id,
          sets,
        });
        return { ...result, statements, request_id };
      } finally {
        sql.options.debug = previousDebug;
      }
    };
    const squat: SetEntry = {
      exercise: "squat",
      kind: "working",
      target_weight_kg: 100,
      target_reps: 5,
    };

    await t.step(
      "twenty off-plan sets cost no more statements than one",
      async () => {
        const one = await measured([squat]);
        const many = await measured(Array.from({ length: 20 }, (_, i) => ({
          ...squat,
          notes: `Set ${i + 1}`,
          target_weight_kg: i === 0 ? 0 : 100,
        })));
        assertEquals(many.session.sets.length, 20);
        assertEquals(
          many.session.sets.map((s) => s.position),
          Array.from({ length: 20 }, (_, i) => i + 1),
        );
        assert(many.session.sets.every((s) => s.mesocycle_id === null));
        assertEquals(many.session.sets[0].target_weight_kg, 0);
        assertEquals(many.session.sets[19].notes, "Set 20");
        assertEquals(many.session.sets[19].reps, null);
        console.info(
          `Session data statements: one set ${one.statements.length}; twenty repeated sets ${many.statements.length}.`,
        );
        assert(
          many.statements.length <= one.statements.length,
          `Repeated sets increased data statements: ${one.statements.length} to ${many.statements.length}.`,
        );
        assert(
          many.statements.length <= 10,
          `One exercise needs at most ten data statements, got ${many.statements.length}.`,
        );
        assertEquals(
          many.statements.filter((q) => /^insert into sets\b/i.test(q)).length,
          1,
        );
      },
    );

    await t.step(
      "a later request sees the new plan instead of cached off-plan attribution",
      async () => {
        const { body } = await api.get("/exercises");
        const lifts: string[] = body.exercises.filter(
          (e: { measure: string; stimulus_type: string }) =>
            e.measure === "load_reps" && e.stimulus_type === "strength",
        ).slice(0, 5).map((e: { name: string }) => e.name);
        assertEquals(lifts.length, 5);
        const plan = await seedPlan({
          exercises: [...new Set(["Back Squat", ...lifts])].map((exercise) => ({
            exercise,
          })),
        });
        const current = await measured([squat]);
        assertEquals(current.session.sets[0].mesocycle_id, plan.mesocycleId);
        const many = await measured(Array.from({ length: 20 }, (_, i) => ({
          ...squat,
          exercise: lifts[i % lifts.length],
        })));
        assert(
          many.session.sets.every((s) => s.mesocycle_id === plan.mesocycleId),
        );
        console.info(
          `Session data statements: twenty sets across five references ${many.statements.length}.`,
        );
        assert(
          many.statements.length <= 20,
          `Five exercise references need at most twenty data statements, got ${many.statements.length}.`,
        );

        const replay = await measured([{
          ...squat,
          exercise: "not in the catalogue",
        }], many.request_id);
        assertEquals(replay.created, false);
        assertEquals(replay.session, many.session);
        assert(replay.statements.every((q) => !/^insert\b/i.test(q)));
        assert(
          replay.statements.length <= 3,
          "A retry must not resolve the replacement payload.",
        );
      },
    );

    await t.step(
      "large sessions stay below the driver's parameter limit and retain positions",
      async () => {
        // Sixteen columns per set: one VALUES statement for this input exceeds
        // Postgres's 65,535-parameter limit. Small requests still use one insert.
        const count = 4_100;
        const result = await measured(Array.from({ length: count }, (_, i) => ({
          ...squat,
          notes: `Large set ${i + 1}`,
        })));
        assertEquals(result.session.sets.length, count);
        assertEquals(
          result.session.sets.map((s) => s.position),
          Array.from({ length: count }, (_, i) => i + 1),
        );
        assertEquals(result.session.sets.at(-1)?.notes, `Large set ${count}`);
        const inserts = result.statements.filter((q) =>
          /^insert into sets\b/i.test(q)
        ).length;
        assert(
          inserts <= 5,
          `Expected bounded batches, got ${inserts} set inserts.`,
        );
      },
    );
  } finally {
    sql.options.debug = previousDebug;
    await sql.end();
  }
});

Deno.test("session batches preserve measures, timestamps and notes at stored precision", async () => {
  await resetTraining();
  await ensureCatalogue();
  const fixtures: { exercise: string; values: Record<string, number> }[] = [
    { exercise: "squat", values: { weight_kg: 0, reps: 7 } },
    { exercise: "box jumps", values: { weight_kg: 5, reps: 3 } },
    { exercise: "broad jumps", values: { distance_m: 2.3 } },
    { exercise: "sprints", values: { distance_m: 100, duration_s: 14.75 } },
    { exercise: "sprints", values: { duration_s: 20.5 } },
  ];
  const fields = [
    "target_weight_kg",
    "target_reps",
    "target_distance_m",
    "target_duration_s",
    "weight_kg",
    "reps",
    "distance_m",
    "duration_s",
    "effort",
    "performed_at",
    "notes",
  ];
  for (const planned of [true, false]) {
    const sets: Record<string, unknown>[] = fixtures.map((f, i) => ({
      exercise: f.exercise,
      kind: "working",
      ...Object.fromEntries(
        Object.entries(f.values).map((
          [key, value],
        ) => [planned ? `target_${key}` : key, value]),
      ),
      ...(!planned
        ? {
          effort: i === 0 ? "hard" : null,
          performed_at: "2020-01-01T10:00:00.000Z",
        }
        : {}),
      notes: `O'Brien's ${planned ? "planned" : "reported"} set ${i + 1}`,
    }));
    const written = await api.post("/sessions", {
      date: today(),
      rationale: "Mixed measures in one batch",
      sets,
    });
    assertEquals(written.status, 201);
    assertEquals(written.body.session.sets.length, sets.length);
    for (const [index, row] of written.body.session.sets.entries()) {
      assertEquals(row.position, index + 1);
      assertEquals(row.kind, "working");
      assertEquals(row.mesocycle_id, null);
      for (const field of fields) {
        assertEquals(
          row[field],
          sets[index][field] ?? null,
          `Set ${index + 1}, ${field}`,
        );
      }
    }
  }
});

Deno.test("repeated exercise references do not reuse another set's plan or validation", async () => {
  await resetTraining();
  await ensureCatalogue();
  const hyp = await seedPlan({ exercises: [{ exercise: "squat" }] });
  const strength = await seedPlan({
    blockId: hyp.blockId,
    track: "strength",
    exercises: [{ exercise: "squat" }],
  });
  const base = { exercise: "squat", target_weight_kg: 100, target_reps: 5 };
  const refused = await api.post("/sessions", {
    date: today(),
    rationale: "The second set still needs an explicit plan",
    sets: [{ ...base, mesocycle: "current:strength" }, base],
  });
  assertEquals(refused.status, 422);
  assert(refused.body.error.includes("more than one active plan"));
  assertEquals((await api.get("/sessions?limit=100")).body.sessions.length, 0);

  const written = await api.post("/sessions", {
    date: today(),
    rationale: "The same exercise can serve different plans",
    sets: [
      { ...base, mesocycle: "current:strength" },
      { ...base, mesocycle: "current:hypertrophy" },
      { ...base, mesocycle: strength.mesocycleId },
    ],
  });
  assertEquals(written.status, 201);
  assertEquals(
    written.body.session.sets.map((s: { mesocycle_id: number }) =>
      s.mesocycle_id
    ),
    [strength.mesocycleId, hyp.mesocycleId, strength.mesocycleId],
  );

  const invalid = await api.post("/sessions", {
    date: today(),
    rationale: "Resolving a reference does not validate later sets",
    sets: [
      { ...base, mesocycle: strength.mesocycleId },
      { exercise: "squat", mesocycle: strength.mesocycleId, distance_m: 100 },
    ],
  });
  assertEquals(invalid.status, 422);
  assertEquals((await api.get("/sessions?limit=100")).body.sessions.length, 1);
});

Deno.test("a database refusal in a later set batch rolls back the whole session and permits retry", async () => {
  await resetTraining();
  await ensureCatalogue();
  const request_id = uuid();
  const sets = Array.from({ length: 4_100 }, () => ({
    exercise: "squat",
    weight_kg: 0,
    reps: 5,
    effort: "hard",
  }));
  const refused = await api.post("/sessions", {
    request_id,
    date: today(),
    rationale: "Last set violates the database warmup rule",
    sets: [...sets.slice(0, -1), { ...sets.at(-1), kind: "warmup" }],
  });
  assertEquals(refused.status, 422);
  assert(refused.body.error.includes("Warmup"));
  assertEquals((await api.get("/sessions?limit=100")).body.sessions, []);
  assertEquals(
    (await api.get("/exercises/squat/history?limit=all")).body.sets,
    [],
  );
  const retried = await api.post("/sessions", {
    request_id,
    date: today(),
    rationale: "Corrected the invalid set; this is not a duplicate",
    sets,
  });
  assertEquals(retried.status, 201);
  assertEquals(retried.body.session.sets.length, sets.length);
  assert(
    retried.body.session.sets.every((
      s: { weight_kg: number; target_reps: number | null },
    ) => s.weight_kg === 0 && s.target_reps === null),
  );
});
