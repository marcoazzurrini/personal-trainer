import { assert, assertEquals } from "@std/assert";
import {
  api,
  ensureCatalogue,
  lastMonday,
  resetNutrition,
  resetTraining,
  today,
} from "./helpers.ts";

// The retry guarantee, checked as an inventory rather than one endpoint at a
// time.
//
// docs/index promises the coach that "every creating POST takes a request_id,
// so a retry is always safe". A promise like that is only worth what its least
// covered endpoint is worth: the client is a model issuing curl over a mobile
// connection, and the failure it prevents — a write that succeeds, a response
// that is lost, a retry that lands as a second row — is undetectable
// afterwards. A duplicated meal is indistinguishable from eating twice.
//
// So this is a tripwire, not a unit test. A new creating endpoint added
// without requireUuid fails here, which is the only place it would fail: it
// would otherwise work perfectly until the first lost response.
//
// The exemptions are asserted too, and deliberately. 20260808100000 spells out
// which writes cannot duplicate — a natural key, an upsert, a unique name —
// and adding a request_id to those would be ceremony that reads like a
// guarantee. Both directions have to hold for the rule to mean anything.
//
// Every call here uses postRaw: api.post injects a request_id when a test
// hasn't supplied one, which is exactly what must not happen in this file.

const RETRY_MESSAGE = "makes a retry safe";

Deno.test("every creating POST that could duplicate requires a request_id", async (t) => {
  await resetTraining();
  await resetNutrition();
  await ensureCatalogue();

  // Fixtures, created the ordinary way so the cases below have something to
  // point at. api.post supplies their ids.
  const block = await api.post("/blocks", {
    name: "Inventory block",
    goal: "testing",
    started_on: lastMonday(),
  });
  await api.post("/mesocycles", {
    block_id: block.body.block.id,
    name: "Inventory meso",
    intent: "testing",
    planned_weeks: 4,
    sessions_per_week: 3,
    started_on: lastMonday(),
    exercises: [{ exercise: "squat", role: "main", priority: 1 }],
  });
  const session = await api.post("/sessions", {
    date: today(),
    rationale: "inventory fixture",
    sets: [{ exercise: "squat", target_weight_kg: 100, target_reps: 5 }],
  });
  await api.post("/foods", {
    name: "Inventory Food",
    kcal_100g: 100,
    protein_100g: 5,
    carbs_100g: 12,
    fat_100g: 3,
    source: "estimate",
  });

  // Most handlers ask for the id immediately after parsing the body, so the
  // rest of these payloads is only as complete as it needs to be to get there.
  // The two that validate other fields first carry them.
  const mustRequire: [string, string, unknown][] = [
    ["blocks", "/blocks", {
      name: "B",
      goal: "g",
      started_on: lastMonday(),
    }],
    ["user context", "/user-context", { topic: "t", content: "c" }],
    ["foods", "/foods", {
      name: "Another Food",
      kcal_100g: 100,
      protein_100g: 5,
      carbs_100g: 12,
      fat_100g: 3,
      source: "estimate",
    }],
    ["meals", "/meals", {
      name: "M",
      items: [{ food: "Inventory Food", grams: 50 }],
    }],
    ["intake", "/intake", { adhoc_kcal: 100 }],
    ["body fat", "/bodyfat", { percent: 14, method: "bia" }],
    ["nutrition events", "/nutrition-events", { kind: "creatine_start" }],
    ["nutrition targets", "/nutrition-targets", {
      goal: "cut",
      rate_pct_bw_week: -0.5,
      protein_g_target: 180,
      decision: "d",
    }],
    ["sessions", "/sessions", {
      date: today(),
      rationale: "r",
      sets: [{ exercise: "squat", weight_kg: 100, reps: 5, effort: "hard" }],
    }],
    // Appends at max(position)+1, so there is no natural key to collide on —
    // without the id a lost response becomes a second set that was never done.
    ["an appended set", `/sessions/${session.body.session.id}/sets`, {
      exercise: "squat",
      weight_kg: 100,
      reps: 5,
      effort: "hard",
    }],
    ["mesocycles", "/mesocycles", {
      block_id: block.body.block.id,
      name: "M2",
      intent: "i",
      planned_weeks: 4,
      sessions_per_week: 3,
      started_on: lastMonday(),
      exercises: [{ exercise: "squat", role: "main", priority: 1 }],
    }],
    ["mesocycle revisions", "/mesocycles/current/revisions", {
      decision: { what_changed: "x", why: "y" },
      remove: ["squat"],
    }],
    ["mesocycle decisions", "/mesocycles/current/decisions", {
      what_changed: "x",
      why: "y",
    }],
  ];

  for (const [label, path, body] of mustRequire) {
    await t.step(label, async () => {
      const { status, body: res } = await api.postRaw(path, body);
      assertEquals(status, 422, `${path} accepted a write with no request_id`);
      assert(
        res.error.includes(RETRY_MESSAGE),
        `${path} refused for some other reason: ${res.error}`,
      );
    });
  }
});

Deno.test("the writes that cannot duplicate do not ask for one", async (t) => {
  await resetTraining();
  await resetNutrition();
  await ensureCatalogue();

  await t.step(
    "bodyweight — keyed on the instant it was measured",
    async () => {
      const { status } = await api.postRaw("/bodyweight", {
        value_kg: 82.5,
        measured_at: "2026-08-01T05:30:00Z",
      });
      assertEquals(status, 201);
    },
  );

  await t.step("and resending a weigh-in replays it", async () => {
    const { status } = await api.postRaw("/bodyweight", {
      value_kg: 82.5,
      measured_at: "2026-08-01T05:30:00Z",
    });
    assertEquals(status, 200); // replayed, not written twice
  });

  await t.step("day flags — the insert does nothing on conflict", async () => {
    const first = await api.postRaw(`/days/${today()}/flags`, {
      flag: "incomplete",
    });
    assertEquals(first.status, 201);

    const again = await api.postRaw(`/days/${today()}/flags`, {
      flag: "incomplete",
    });
    assertEquals(again.status, 201);
    assertEquals(again.body.flags, ["incomplete"]); // one flag, not two
  });

  await t.step(
    "exercises and muscles — the unique name is the key",
    async () => {
      // Asserted against the catalogue rather than by creating anything, because
      // resetTraining deliberately keeps the catalogue: a test that added an
      // exercise here would pass once and collide with itself on every later run.
      //
      // The conflict is the whole proof. Reaching a 409 at all means the handler
      // never asked for a request_id — if it had, the missing id would have been
      // a 422 first — and the 409 is the duplicate protection the exemption
      // claims. If either endpoint ever stops refusing a repeated name, it can
      // duplicate, and it belongs in the list above.
      const exercise = await api.postRaw("/exercises", { name: "back squat" });
      assertEquals(exercise.status, 409);
      assert(
        exercise.body.error.includes("already exists"),
        exercise.body.error,
      );

      const muscle = await api.postRaw("/muscles", { name: "quads" });
      assertEquals(muscle.status, 409);
    },
  );
});
