import { assert, assertEquals } from "@std/assert";
import d1 from "./d1.ts";
import { api, ensureCatalogue, resetTraining, today } from "./helpers.ts";
import { database } from "./d1.ts";
import { sessionStore } from "../training/sessions.ts";

async function draft(count = 3) {
  const created = await api.post("/sessions", {
    date: today(),
    rationale: "Session report fixture",
    sets: Array.from({ length: count }, (_, i) => ({
      exercise: "squat",
      target_weight_kg: 100,
      target_reps: 5,
      notes: `Planned set ${i + 1}`,
    })),
  });
  assertEquals(created.status, 201);
  return created.body.session;
}

Deno.test("one session report records only named sets and session facts, and retries without restamping", async () => {
  await resetTraining();
  await ensureCatalogue();
  const before = await draft();
  const payload = {
    completed_at: "2020-01-01T11:00:00Z",
    overall_feel: "Solid",
    notes: "Reported together",
    sets: [
      {
        id: before.sets[1].id,
        weight_kg: 95,
        reps: 6,
        effort: "hard",
        notes: null,
      },
      { id: before.sets[0].id, weight_kg: 0, reps: 7, effort: "easy" },
    ],
  };
  const written = await api.patch(`/sessions/${before.id}`, payload);
  assertEquals(written.status, 200);
  const session = written.body.session;
  assertEquals(session.completed_at, "2020-01-01T11:00:00.000Z");
  assertEquals(session.overall_feel, "Solid");
  assertEquals(session.notes, "Reported together");
  assertEquals(
    session.sets.map((s: { id: number }) => s.id),
    before.sets.map((s: { id: number }) => s.id),
  );
  assertEquals(session.sets[0].weight_kg, 0);
  assertEquals(session.sets[0].notes, "Planned set 1");
  assertEquals(session.sets[1].notes, null);
  assert(session.sets[0].performed_at !== null);
  assert(session.sets[1].performed_at !== null);
  assertEquals(session.sets[2], before.sets[2]);
  assertEquals(
    session.sets.map((s: { target_weight_kg: number }) => s.target_weight_kg),
    [100, 100, 100],
  );
  const retry = await api.patch(`/sessions/${before.id}`, payload);
  assertEquals(retry.status, 200);
  assertEquals(retry.body, written.body);

  const partial = await api.patch(`/sessions/${before.id}`, {
    sets: [{ id: before.sets[1].id, reps: 8 }],
  });
  assertEquals(partial.status, 200);
  assertEquals(partial.body.session.sets[1], { ...session.sets[1], reps: 8 });
  const cleared = await api.patch(`/sessions/${before.id}`, {
    completed_at: null,
    sets: [{
      id: before.sets[1].id,
      weight_kg: null,
      reps: null,
      effort: null,
      performed_at: null,
    }],
  });
  assertEquals(cleared.status, 200);
  assertEquals(cleared.body.session.completed_at, null);
  assertEquals(cleared.body.session.sets[1], {
    ...partial.body.session.sets[1],
    weight_kg: null,
    reps: null,
    effort: null,
    performed_at: null,
  });
});

Deno.test("a session report refuses invalid entries without changing any set or session fact", async (t) => {
  await resetTraining();
  await ensureCatalogue();
  const before = await draft();
  const foreign = await draft(1);
  const valid = {
    id: before.sets[0].id,
    weight_kg: 100,
    reps: 5,
    effort: "hard",
  };
  const cases: [string, unknown, number, string][] = [
    ["empty list", [], 422, "sets"],
    ["null list", null, 422, "sets"],
    ["duplicate id", [valid, valid], 422, "once"],
    ["conflicting duplicate", [valid, { ...valid, reps: 8 }], 422, "once"],
    ["missing id", [{ weight_kg: 100, reps: 5, effort: "hard" }], 422, "id"],
    ["string id", [{ ...valid, id: String(valid.id) }], 422, "id"],
    ["fractional id", [{ ...valid, id: 1.5 }], 422, "id"],
    ["empty correction", [{ id: valid.id }], 422, "at least one"],
    ["unknown field", [{ ...valid, repz: 5 }], 422, "repz"],
    ["target change", [{ ...valid, target_reps: 8 }], 422, "immutable"],
    [
      "target clearing",
      [{ ...valid, target_weight_kg: null }],
      422,
      "immutable",
    ],
    [
      "missing effort",
      [valid, { id: before.sets[1].id, weight_kg: 100, reps: 5 }],
      422,
      "effort",
    ],
    [
      "wrong measure",
      [valid, { id: before.sets[1].id, distance_m: 100 }],
      422,
      "distance_m",
    ],
    ["absent set", [valid, { ...valid, id: 2_000_000_000 }], 404, "session"],
    [
      "another session's set",
      [valid, { ...valid, id: foreign.sets[0].id }],
      404,
      "session",
    ],
  ];
  for (const [name, sets, status, message] of cases) {
    await t.step(name, async () => {
      const result = await api.patch(`/sessions/${before.id}`, {
        sets,
        notes: "Must not survive",
      });
      assertEquals(result.status, status);
      assert(result.body.error.includes(message), result.body.error);
      assertEquals(
        (await api.get(`/sessions/${before.id}`)).body.session,
        before,
      );
      assertEquals(
        (await api.get(`/sessions/${foreign.id}`)).body.session,
        foreign,
      );
    });
  }
  assertEquals(
    (await api.patch("/sessions/2000000000", { sets: [valid] })).status,
    404,
  );
});

Deno.test("session reports use the same measure and effort rules as single-set corrections", async () => {
  await resetTraining();
  await ensureCatalogue();
  const created = await api.post("/sessions", {
    date: today(),
    rationale: "Mixed report",
    sets: [
      {
        exercise: "squat",
        kind: "warmup",
        target_weight_kg: 20,
        target_reps: 5,
      },
      { exercise: "box jumps", target_reps: 3 },
      { exercise: "sprints", target_distance_m: 100 },
      { exercise: "broad jumps", target_distance_m: 2.3 },
    ],
  });
  assertEquals(created.status, 201);
  const before = created.body.session;
  const actuals = [
    { weight_kg: 20, reps: 5 },
    { reps: 3 },
    { duration_s: 14.75 },
    { distance_m: 2.4 },
  ];
  const result = await api.patch(`/sessions/${before.id}`, {
    sets: actuals.map((actual, i) => ({ id: before.sets[i].id, ...actual })),
  });
  assertEquals(result.status, 200);
  for (const [i, actual] of actuals.entries()) {
    const row = result.body.session.sets[i];
    for (const [field, value] of Object.entries(actual)) {
      assertEquals(row[field], value);
    }
    assertEquals(row.effort, null);
    assert(row.performed_at !== null);
  }
  const bad = await api.patch(`/sessions/${before.id}`, {
    sets: [{ id: before.sets[1].id, distance_m: 2 }],
  });
  assertEquals(bad.status, 422);
  assertEquals((await api.get(`/sessions/${before.id}`)).body, result.body);
});

Deno.test("database refusals roll back both the set update and session facts", async () => {
  await resetTraining();
  await ensureCatalogue();
  const before = await draft();
  const db = d1();
  try {
    await db`create trigger test_report_note before update on sessions
      when new.notes = 'reject report' begin
      select raise(abort, 'CHECK constraint failed: test_report_note'); end`;
    const payload = {
      sets: before.sets.map((s: { id: number }) => ({
        id: s.id,
        weight_kg: 100,
        reps: 5,
        effort: "hard",
      })),
      notes: "reject report",
    };
    const refused = await api.patch(`/sessions/${before.id}`, payload);
    assertEquals(refused.status, 422);
    assertEquals(
      (await api.get(`/sessions/${before.id}`)).body.session,
      before,
    );
    const corrected = await api.patch(`/sessions/${before.id}`, {
      ...payload,
      notes: "Corrected",
    });
    assertEquals(corrected.status, 200);
    assert(
      corrected.body.session.sets.every((s: { reps: number | null }) =>
        s.reps === 5
      ),
    );
  } finally {
    await db`drop trigger if exists test_report_note`;
    await db.end();
  }

  const created = await api.post("/sessions", {
    date: today(),
    rationale: "Database warmup refusal",
    sets: [{ exercise: "squat", target_weight_kg: 100, target_reps: 5 }, {
      exercise: "squat",
      kind: "warmup",
      target_weight_kg: 20,
      target_reps: 5,
    }],
  });
  assertEquals(created.status, 201);
  const warmup = created.body.session;
  const bad = await api.patch(`/sessions/${warmup.id}`, {
    notes: "Must roll back",
    completed_at: "2020-01-01T11:00:00Z",
    sets: warmup.sets.map((s: { id: number }) => ({
      id: s.id,
      weight_kg: 20,
      reps: 5,
      effort: "easy",
    })),
  });
  assertEquals(bad.status, 422);
  assert(bad.body.error.includes("Warmup"));
  assertEquals((await api.get(`/sessions/${warmup.id}`)).body.session, warmup);
});

Deno.test("omitted actual fields retain database precision during a report", async () => {
  await resetTraining();
  await ensureCatalogue();
  const before = await draft(1);
  const id = before.sets[0].id;
  const db = d1();
  try {
    // JS Date reads only milliseconds. A notes correction must not round an
    // existing database timestamp merely because that row was read to validate.
    await db`update sets set weight_kg = 10000, reps = 5, effort = 'hard',
      performed_at = '2020-01-01T10:00:00.123456Z' where id = ${id}`;
    const [original] =
      await db`select performed_at as stamp from sets where id = ${id}`;
    const result = await api.patch(`/sessions/${before.id}`, {
      sets: [{ id, notes: "Only a note" }],
    });
    assertEquals(result.status, 200);
    const [after] =
      await db`select performed_at as stamp from sets where id = ${id}`;
    assertEquals(after.stamp, original.stamp);
  } finally {
    await db.end();
  }
});

Deno.test("a skipped database update cannot look like a successful report", async () => {
  await resetTraining();
  await ensureCatalogue();
  const before = await draft();
  const db = d1();
  try {
    await db`create trigger test_report_skip before update on sets
      when new.notes = 'skip this set' begin select raise(ignore); end`;
    const refused = await api.patch(`/sessions/${before.id}`, {
      notes: "Must not survive",
      sets: before.sets.map((s: { id: number }, i: number) => ({
        id: s.id,
        weight_kg: 100,
        reps: 5,
        effort: "hard",
        notes: i === 1 ? "skip this set" : "Recorded",
      })),
    });
    assertEquals(refused.status, 409);
    assertEquals(
      (await api.get(`/sessions/${before.id}`)).body.session,
      before,
    );
  } finally {
    await db`drop trigger if exists test_report_skip`;
    await db.end();
  }
});

Deno.test("reports and single-set corrections revalidate concurrent partial values", async () => {
  await resetTraining();
  await ensureCatalogue();
  for (const firstWriter of ["set", "session"]) {
    const planned = await draft(1);
    const id = planned.sets[0].id;
    assertEquals(
      (await api.patch(`/sets/${id}`, {
        weight_kg: 100,
        reps: 5,
        effort: "hard",
      })).status,
      200,
    );
    const clear = {
      weight_kg: null,
      reps: null,
      effort: null,
      performed_at: null,
    };
    const [cleared, corrected] = await Promise.all([
      firstWriter === "set"
        ? api.patch(`/sets/${id}`, clear)
        : api.patch(`/sessions/${planned.id}`, { sets: [{ id, ...clear }] }),
      firstWriter === "set"
        ? api.patch(`/sessions/${planned.id}`, { sets: [{ id, reps: 6 }] })
        : api.patch(`/sets/${id}`, { reps: 6 }),
    ]);
    assertEquals(cleared.status, 200);
    // Either correction wins before clearing, or revalidation refuses after it.
    assert([200, 422].includes(corrected.status));
    assertEquals(
      (await api.get(`/sessions/${planned.id}`)).body.session,
      planned,
    );
  }
});

Deno.test("session report D1 writes stay bounded and return all twenty sets", async () => {
  await resetTraining();
  await ensureCatalogue();
  const before = await draft(20);
  const writes: number[] = [];
  const observed = {
    ...database,
    batch: async <T>(statements: Parameters<typeof database.batch>[0]) => {
      writes.push(statements.length);
      return await database.batch<T>(statements);
    },
  };
  const saved = await sessionStore(observed).correctSession(before.id, {
    sets: before.sets.map((s: { id: number }) => ({
      id: s.id,
      weight_kg: 100,
      reps: 5,
      effort: "hard" as const,
    })),
    notes: "One report",
  });
  assertEquals(saved.sets.length, 20);
  assert(saved.sets.every((s) => s.reps === 5));
  assertEquals(saved.completed_at, null);
  // The first batch takes a consistent read; the second validates its version
  // and commits all writes and response reads atomically.
  assertEquals(writes.length, 2);
  assertEquals(writes[0], 2);
  assert(writes[1] <= 8, `Expected bounded native D1 writes, got ${writes[1]}`);
});
