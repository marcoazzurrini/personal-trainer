import { assert, assertEquals } from "@std/assert";
import {
  api,
  type ApiResponse,
  daysBefore,
  ensureCatalogue,
  lastFinishedSunday,
  lastMonday,
  resetNutrition,
  resetTraining,
  seedWeighIns,
  today,
  uuid,
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
      track: "strength",
      intent: "i",
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

// The other half of the promise, and the half that was never checked.
//
// The inventory above proves every creating POST *asks* for a request_id. It
// does not prove any of them *honours* one, and those are different claims: an
// endpoint can require the id, ignore it completely, and pass. What the caller
// was promised is the second thing — "resending the same id returns the
// original result instead of writing a second row" — so it is asserted the
// only way it can be, by sending the same call twice.
//
// 201 then 200 is the whole guarantee. 201 twice is a duplicate row, and the
// caller cannot tell: both answers look like success, and the second meal is
// indistinguishable from eating twice. An error on the second is the same
// promise broken more loudly — the unique constraint on request_id catching
// what the handler forgot to.
Deno.test("resending a request_id replays the original result", async (t) => {
  await resetTraining();
  await resetNutrition();
  await ensureCatalogue();

  const block = await api.post("/blocks", {
    name: "Replay block",
    goal: "testing",
    started_on: lastMonday(),
  });
  const blockId = block.body.block.id;
  await api.post("/mesocycles", {
    block_id: blockId,
    name: "Replay meso",
    track: "hypertrophy",
    intent: "testing",
    planned_weeks: 4,
    sessions_per_week: 3,
    started_on: lastMonday(),
    exercises: [
      {
        exercise: "squat",
        role: "main",
        priority: 1,
        weekly_dose: 9,
        weekly_dose_unit: "sets",
      },
      {
        exercise: "bench press",
        role: "main",
        priority: 2,
        weekly_dose: 9,
        weekly_dose_unit: "sets",
      },
    ],
  });
  const session = await api.post("/sessions", {
    date: today(),
    rationale: "replay fixture",
    sets: [{ exercise: "squat", target_weight_kg: 100, target_reps: 5 }],
  });
  await api.post("/foods", {
    name: "Replay Food",
    kcal_100g: 100,
    protein_100g: 5,
    carbs_100g: 12,
    fat_100g: 3,
    source: "estimate",
  });
  await api.post("/foods", {
    name: "Replay Food Two",
    kcal_100g: 168,
    protein_100g: 20,
    carbs_100g: 4,
    fat_100g: 8,
    source: "estimate",
  });
  // Two items, so logging it writes two rows from one request_id. That is the
  // case intake_entries_request_food_key exists for, and the one a plain
  // unique request_id could not express.
  await api.post("/meals", {
    name: "Replay Day Meal",
    items: [
      { food: "Replay Food", grams: 50 },
      { food: "Replay Food Two", grams: 60 },
    ],
  });
  // The provisional path: a goal and an explicit kcal figure, which is what
  // onboarding has before there is enough history to solve for one. It needs a
  // bodyweight and nothing else.
  await seedWeighIns([daysBefore(lastFinishedSunday(), 1)], 82);

  interface Replay {
    label: string;
    path: string;
    body: unknown;
    identity: (b: ApiResponse["body"]) => unknown;
  }

  const replays: Replay[] = [
    {
      label: "blocks",
      path: "/blocks",
      body: { name: "Replayed block", goal: "g", started_on: lastMonday() },
      identity: (b) => b.block.id,
    },
    {
      label: "user context",
      path: "/user-context",
      body: { topic: "replay", content: "c" },
      identity: (b) => b.entry.id,
    },
    {
      label: "foods",
      path: "/foods",
      body: {
        name: "Replayed Food",
        kcal_100g: 100,
        protein_100g: 5,
        carbs_100g: 12,
        fat_100g: 3,
        source: "estimate",
      },
      identity: (b) => b.food.id,
    },
    {
      label: "meals",
      path: "/meals",
      body: {
        name: "Replayed Meal",
        items: [{ food: "Replay Food", grams: 50 }],
      },
      identity: (b) => b.meal.id,
    },
    // The only site that replays a different entity than it wrote. A logged
    // day is answered with the whole day, so identity is the day's entries
    // rather than a row id: a retry that got through would show up as four
    // entries where the first call left two, which is what "indistinguishable
    // from eating twice" means when it happens.
    {
      label: "intake",
      path: "/intake",
      body: { meal: "Replay Day Meal" },
      identity: (b) => b.entries.map((e: { id: number }) => e.id),
    },
    {
      label: "nutrition events",
      path: "/nutrition-events",
      body: { kind: "creatine_start" },
      identity: (b) => b.event.id,
    },
    // The only site whose replay is a different shape from its creation: 201
    // carries the computation blocks that justified the target, 200 answers
    // with the row alone. identity reads through target, which is the half
    // both shapes share — asserting on computation would fail against the
    // replay by design rather than by regression.
    {
      label: "nutrition targets",
      path: "/nutrition-targets",
      body: {
        goal: "cut",
        rate_pct_bw_week: -0.5,
        kcal_target: 2300,
        protein_g_target: 180,
        decision: "Provisional, for the replay inventory.",
      },
      identity: (b) => b.target.id,
    },
    {
      label: "sessions",
      path: "/sessions",
      body: {
        date: today(),
        rationale: "replayed",
        sets: [{ exercise: "squat", weight_kg: 100, reps: 5, effort: "hard" }],
      },
      identity: (b) => b.session.id,
    },
    {
      label: "an appended set",
      path: `/sessions/${session.body.session.id}/sets`,
      body: { exercise: "squat", weight_kg: 100, reps: 5, effort: "hard" },
      identity: (b) => b.set.id,
    },
    {
      label: "body fat",
      path: "/bodyfat",
      body: { percent: 14, method: "bia" },
      identity: (b) => b.bodyfat_estimate.id,
    },
    {
      label: "mesocycles",
      path: "/mesocycles",
      body: {
        block_id: blockId,
        name: "Replayed meso",
        track: "strength",
        intent: "i",
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
      },
      identity: (b) => b.mesocycle.id,
    },
    // Named by track: the strength plan created above is active too, and
    // "current" alone is ambiguous once a second one exists.
    //
    // Without the preamble the repeat would reach the plan a second time and
    // refuse — "bench press" is no longer in it to remove — so replaying the
    // original is the assertion that the retry never got that far.
    {
      label: "a decision that changes the plan",
      path: "/mesocycles/current:hypertrophy/decisions",
      body: { what_changed: "x", why: "y", remove: ["bench press"] },
      identity: (b) => b.decision.id,
    },
    {
      label: "a decision that changes nothing",
      path: "/mesocycles/current:hypertrophy/decisions",
      body: { what_changed: "x", why: "y" },
      identity: (b) => b.decision.id,
    },
  ];

  for (const replay of replays) {
    await t.step(replay.label, async () => {
      const sent = {
        ...(replay.body as Record<string, unknown>),
        request_id: uuid(),
      };

      const first = await api.postRaw(replay.path, sent);
      assertEquals(
        first.status,
        201,
        `${replay.path} first call: ${first.body.error}`,
      );

      const again = await api.postRaw(replay.path, sent);
      assertEquals(
        again.status,
        200,
        `${replay.path} answered ${again.status} to a repeated request_id — a ` +
          `retry must replay the original, not write again: ${again.body.error}`,
      );
      assertEquals(
        replay.identity(again.body),
        replay.identity(first.body),
        `${replay.path} replayed something other than the original row`,
      );
    });
  }

  // The one retry the inventory above cannot state, because it sends a body
  // twice unchanged and this failure needs the body to move.
  //
  // POST /bodyfat defaults day to Rome's today and dedupes on (day, method),
  // and those two together hide whether the request_id is honoured at all: a
  // same-day retry is caught by the natural key either way, so the entry above
  // passes with the preamble removed. Only a retry that crosses midnight tells
  // them apart — it lands on a free (day, method), and nothing but the
  // request_id can still recognise it as the call already answered.
  await t.step("body fat, retried after the day moved", async () => {
    const id = uuid();
    const recorded = daysBefore(today(), 3);

    const first = await api.postRaw("/bodyfat", {
      percent: 18.5,
      method: "dxa",
      day: recorded,
      request_id: id,
    });
    assertEquals(first.status, 201, `first call: ${first.body.error}`);

    // The same call arriving again with the day underneath it moved on.
    const again = await api.postRaw("/bodyfat", {
      percent: 18.5,
      method: "dxa",
      day: daysBefore(today(), 2),
      request_id: id,
    });
    assertEquals(
      again.status,
      200,
      `a retry whose day had moved answered ${again.status} instead of ` +
        `replaying the original: ${again.body.error}`,
    );
    assertEquals(
      again.body.bodyfat_estimate.id,
      first.body.bodyfat_estimate.id,
      "the retry wrote a second estimate rather than replaying the first",
    );
    assertEquals(
      again.body.bodyfat_estimate.day,
      recorded,
      "the replay carried the day the retry arrived on, not the day it recorded",
    );
  });

  // The retry guarantee is per plan, not per table.
  //
  // mesocycle_decisions is the one table two endpoints wrote, and the lookup
  // asked only whether the id had been seen — so an id spent on one plan
  // replayed for another, answering 200 with a plan nothing had touched. The
  // endpoints are one now and the lookup is scoped, which leaves the reuse
  // visible: it reaches the write and the unique constraint refuses it.
  await t.step("a decision id spent on one plan is not another's", async () => {
    const id = uuid();

    const first = await api.postRaw(
      "/mesocycles/current:hypertrophy/decisions",
      { what_changed: "held", why: "reps climbing", request_id: id },
    );
    assertEquals(first.status, 201, `first call: ${first.body.error}`);

    const crossed = await api.postRaw(
      "/mesocycles/current:strength/decisions",
      { what_changed: "held", why: "reps climbing", request_id: id },
    );
    assertEquals(
      crossed.status,
      409,
      `an id spent on another plan answered ${crossed.status} — a replay here ` +
        `reports success for a decision that was never recorded: ` +
        `${crossed.body.error}`,
    );

    const log = await api.get("/mesocycles/current:strength/decisions");
    assertEquals(
      log.body.decisions.length,
      0,
      "the crossed id recorded a decision against the wrong plan",
    );
  });
});
