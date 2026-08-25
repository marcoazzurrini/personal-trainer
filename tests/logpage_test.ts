import { assert, assertEquals } from "@std/assert";
import {
  api,
  BASE,
  ensureCatalogue,
  resetTraining,
  seedPlan,
  today,
} from "./helpers.ts";

// The tokenless namespace: the public_id is the auth, handlers write to
// Postgres directly, and the database CHECKs still bite through this path.
Deno.test("log page namespace", async (t) => {
  await resetTraining();
  await ensureCatalogue();

  const { mesocycleId } = await seedPlan({
    exercises: [
      { exercise: "squat", weekly_dose: 9, notes: "6-10 reps" },
      {
        exercise: "sprint",
        role: "accessory",
        weekly_dose: 0.4,
        weekly_dose_unit: "km",
      },
    ],
  });
  const session = await api.post("/sessions", {
    date: today(),
    rationale: "log page test",
    sets: [
      { exercise: "squat", target_weight_kg: 100, target_reps: 5 },
      { exercise: "squat", target_weight_kg: 100, target_reps: 5 },
      { exercise: "sprint", target_distance_m: 40, target_duration_s: 5.2 },
    ],
  });
  const publicId = session.body.session.public_id;
  const setId = session.body.session.sets[0].id;
  const s = (path: string) => `${BASE}/s/${publicId}${path}`;

  await t.step("the page renders without any token", async () => {
    const res = await fetch(s(""));
    assertEquals(res.status, 200);
    const html = await res.text();
    assert(html.includes("Back Squat"));
    assert(!html.includes("local-dev-token")); // the coach token never appears
  });

  await t.step("a wrong public_id is a 404", async () => {
    const res = await fetch(`${BASE}/s/definitely-wrong`);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  });

  await t.step("the effort CHECK bites through this path too", async () => {
    const res = await fetch(s(`/sets/${setId}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weight_kg: 100, reps: 5 }),
    });
    assertEquals(res.status, 422);
    const body = await res.json();
    assert(body.error.includes("effort"));
  });

  await t.step(
    "logging a set stamps performed_at and starts the clock",
    async () => {
      const res = await fetch(s(`/sets/${setId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weight_kg: 100, reps: 5, effort: "hard" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assert(body.set.performed_at !== null);
      const check = await api.get(`/sessions/${session.body.session.id}`);
      assert(check.body.session.started_at !== null);
    },
  );

  await t.step("a set from another session is unreachable here", async () => {
    const other = await api.post("/sessions", {
      date: today(),
      rationale: "other session",
      sets: [{ exercise: "bench", target_weight_kg: 80, target_reps: 5 }],
    });
    const foreignSetId = other.body.session.sets[0].id;
    const res = await fetch(s(`/sets/${foreignSetId}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weight_kg: 80, reps: 5, effort: "easy" }),
    });
    assertEquals(res.status, 404);
    await res.body?.cancel();
  });

  await t.step("an unplanned set post is retry-safe by position", async () => {
    const body = {
      exercise_id: session.body.session.sets[0].exercise_id,
      position: 10,
      kind: "working",
      weight_kg: 100,
      reps: 3,
      effort: "failure",
    };
    const first = await fetch(s("/sets"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assertEquals(first.status, 201);
    const firstBody = await first.json();
    const retry = await fetch(s("/sets"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, reps: 4 }), // corrected on retry
    });
    assertEquals(retry.status, 201);
    const retryBody = await retry.json();
    assertEquals(retryBody.set.id, firstBody.set.id); // same row, not a twin
    const check = await api.get(`/sessions/${session.body.session.id}`);
    const unplanned = check.body.session.sets.find(
      (x: { position: number }) => x.position === 10,
    );
    assertEquals(unplanned.reps, 4); // latest wins
    assertEquals(unplanned.target_weight_kg, null);
  });

  // The page renders whatever the exercise records; these two steps are the
  // write half of that — a sprint logged in metres and seconds through the
  // same tokenless path a squat uses.
  await t.step("a sprint logs in metres and seconds", async () => {
    const sprintSet = session.body.session.sets.find(
      (x: { exercise: string }) => x.exercise === "Sprint",
    );
    assertEquals(sprintSet.measure, "distance_duration");
    const res = await fetch(s(`/sets/${sprintSet.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ distance_m: 40, duration_s: 5.18 }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.set.distance_m, 40);
    assertEquals(body.set.duration_s, 5.18);
    assert(body.set.performed_at !== null); // the clock starts on its own
  });

  await t.step("the measure rule bites through this path too", async () => {
    const sprintSet = session.body.session.sets.find(
      (x: { exercise: string }) => x.exercise === "Sprint",
    );
    const res = await fetch(s(`/sets/${sprintSet.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weight_kg: 100, reps: 5 }),
    });
    assertEquals(res.status, 422);
    const body = await res.json();
    assert(body.error.includes("not reps"), body.error);
  });

  // The page has no idea plans exist. It posts an exercise and a position;
  // which plan the work serves is worked out server-side, exactly as it is
  // when the coach logs the same set in chat.
  await t.step(
    "an unplanned set is attributed without the page saying so",
    async () => {
      const res = await fetch(s("/sets"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exercise_id: session.body.session.sets.find(
            (x: { exercise: string }) => x.exercise === "Sprint",
          ).exercise_id,
          position: 20,
          kind: "working",
          distance_m: 40,
          duration_s: 5.4,
        }),
      });
      assertEquals(res.status, 201);
      await res.body?.cancel();
      const check = await api.get(`/sessions/${session.body.session.id}`);
      const added = check.body.session.sets.find(
        (x: { position: number }) => x.position === 20,
      );
      assertEquals(added.mesocycle_id, mesocycleId);
    },
  );

  await t.step("notes save without finishing the session", async () => {
    const res = await fetch(s("/notes"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "Back Squat: knee fine" }),
    });
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const check = await api.get(`/sessions/${session.body.session.id}`);
    assertEquals(check.body.session.notes, "Back Squat: knee fine");
    assertEquals(check.body.session.completed_at, null);
  });

  await t.step(
    "finish completes once and keeps the first timestamp",
    async () => {
      await fetch(s("/finish"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overall_feel: "solid" }),
      }).then((r) => r.body?.cancel());
      const first = await api.get(`/sessions/${session.body.session.id}`);
      await fetch(s("/finish"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.body?.cancel());
      const second = await api.get(`/sessions/${session.body.session.id}`);
      assertEquals(second.body.session.overall_feel, "solid");
      assertEquals(
        second.body.session.completed_at,
        first.body.session.completed_at,
      );
    },
  );
});
