import { assert, assertEquals } from "@std/assert";
import {
  api,
  ensureCatalogue,
  resetNutrition,
  resetTraining,
  seedPlan,
  today,
} from "./helpers.ts";

// The procedures may omit a read only because another response supplies its
// facts. Prose checks alone cannot establish that the API keeps that promise.
Deno.test("training-state supplies current context both before and during a plan", async () => {
  await resetTraining();
  await ensureCatalogue();
  for (
    const content of [
      "Needs 48 hours between heavy days",
      "Needs 72 hours between heavy days",
    ]
  ) {
    assertEquals(
      (await api.post("/user-context", { topic: "recovery", content })).status,
      201,
    );
  }
  const current = (await api.get("/user-context")).body.context;
  assertEquals(current.length, 1);
  assertEquals(current[0].content, "Needs 72 hours between heavy days");
  const before = await api.get("/training-state");
  assertEquals(before.status, 200);
  assertEquals(before.body.user_context, current);
  await seedPlan({ exercises: [{ exercise: "squat" }] });
  const during = await api.get("/training-state");
  assertEquals(during.status, 200);
  assertEquals(during.body.user_context, current);
});

Deno.test("session detail and exercise history supply effort while session lists supply headers only", async () => {
  await resetTraining();
  await ensureCatalogue();
  const written = await api.post("/sessions", {
    date: today(),
    rationale: "Effort read regression",
    sets: [
      { exercise: "squat", weight_kg: 20, reps: 5, kind: "warmup" },
      { exercise: "squat", weight_kg: 100, reps: 5, effort: "hard" },
      { exercise: "squat", target_weight_kg: 100, target_reps: 5 },
    ],
  });
  assertEquals(written.status, 201);
  const list = await api.get("/sessions?limit=30");
  assertEquals(list.status, 200);
  assertEquals(list.body.sessions.length, 1);
  assert(!("sets" in list.body.sessions[0]));
  const detail = await api.get(`/sessions/${list.body.sessions[0].id}`);
  assertEquals(detail.status, 200);
  const efforts = detail.body.session.sets.filter(
    (s: { kind: string; effort: string | null }) =>
      s.kind === "working" && s.effort !== null,
  ).map((s: { effort: string }) => s.effort);
  assertEquals(efforts, ["hard"]);
  const history = await api.get("/exercises/squat/history?limit=20");
  assertEquals(history.status, 200);
  assertEquals(
    history.body.sets.map((s: { effort: string }) => s.effort),
    efforts,
  );
});

Deno.test("direct meal logging resolves aliases and returns the same day facts as a read", async () => {
  await resetNutrition();
  assertEquals(
    (await api.post("/foods", {
      name: "Workflow yogurt",
      kcal_100g: 100,
      protein_100g: 25,
      carbs_100g: 0,
      fat_100g: 0,
      source: "label",
    })).status,
    201,
  );
  assertEquals(
    (await api.post("/meals", {
      name: "Workflow breakfast",
      aliases: ["la colazione del test"],
      items: [{ food: "Workflow yogurt", grams: 200 }],
    })).status,
    201,
  );
  assertEquals(
    (await api.post("/intake", {
      day: today(),
      adhoc_kcal: 300,
      note: "Unknown protein in the earlier meal",
    })).status,
    201,
  );
  assertEquals(
    (await api.post(`/days/${today()}/flags`, { flag: "incomplete" })).status,
    201,
  );

  // No preliminary GET /meals or GET /foods: POST resolves the known alias.
  const logged = await api.post("/intake", {
    meal: "LA COLAZIONE DEL TEST",
    scale: 0.5,
    day: today(),
  });
  assertEquals(logged.status, 201);
  assertEquals(logged.body.entries.length, 2);
  assertEquals(logged.body.totals.kcal, 400);
  assertEquals(logged.body.totals.protein_g, 25);
  assertEquals(logged.body.totals.unaccounted.protein_g, {
    entries: 1,
    kcal: 300,
  });
  assertEquals(logged.body.flags, ["incomplete"]);
  const read = await api.get(`/intake?day=${today()}`);
  assertEquals(read.status, 200);
  assertEquals(logged.body, read.body);
});
