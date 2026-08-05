import { assert, assertEquals } from "@std/assert";
import { api, ensureCatalogue, resetTraining } from "./helpers.ts";

Deno.test("reference data", async (t) => {
  await resetTraining();
  await ensureCatalogue();

  await t.step("the catalogue is loaded with aliases and muscles", async () => {
    const { status, body } = await api.get("/exercises");
    assertEquals(status, 200);
    assert(body.exercises.length >= 54);
    const squat = body.exercises.find(
      (e: { name: string }) => e.name === "Back Squat",
    );
    assert(squat.aliases.includes("squat"));
    assert(
      squat.muscles.some(
        (m: { muscle: string; counts: boolean }) =>
          m.muscle === "quads" && m.counts,
      ),
    );
  });

  await t.step("duplicate exercise names are rejected, any case", async () => {
    const { status, body } = await api.post("/exercises", {
      name: "back squat",
    });
    assertEquals(status, 409);
    assert(body.error.includes("already exists"));
  });

  await t.step("an unknown muscle names the known ones", async () => {
    const { status, body } = await api.post("/exercises", {
      name: "Test Exercise",
      muscles: [{ muscle: "quadz", counts: true, fatigue: "lots" }],
    });
    assertEquals(status, 422);
    assert(body.error.includes("quads"));
  });

  await t.step("user context: latest row per topic wins", async () => {
    await api.post("/user-context", {
      topic: "lower back",
      content: "wants 48h between heavy days",
    });
    await api.post("/user-context", {
      topic: "lower back",
      content: "fine lately",
    });
    const current = await api.get("/user-context");
    const rows = current.body.context.filter(
      (r: { topic: string }) => r.topic === "lower back",
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].content, "fine lately");

    const history = await api.get("/user-context?history=true");
    assertEquals(history.body.history.length, 2);
  });

  await t.step("bodyweight dedupes on its natural key", async () => {
    const measurement = {
      value_kg: 82.5,
      measured_at: "2026-08-01T07:30:00Z",
    };
    const first = await api.post("/bodyweight", measurement);
    assertEquals(first.status, 201);
    const retry = await api.post("/bodyweight", measurement);
    assertEquals(retry.status, 200);
    assertEquals(retry.body.bodyweight.id, first.body.bodyweight.id);

    const conflicting = await api.post("/bodyweight", {
      ...measurement,
      value_kg: 83.1,
    });
    assertEquals(conflicting.status, 409);
  });
});
