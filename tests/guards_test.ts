import { assert, assertEquals } from "@std/assert";
import { api, daysAgo, resetNutrition, today, uuid } from "./helpers.ts";

// The guards that stop a typo becoming a fact.
//
// Everything here shares one shape: a wrong number that is syntactically
// perfect, accepted silently, and then read back later as if it were true.
// None of these would ever surface as an error — they surface as a calorie
// target that is quietly a few hundred kcal wrong, weeks later, with nothing
// in the record pointing at the cause. That is why they are guards at the
// write, and why each one is pinned here rather than left to review.
//
// Separate small tests rather than one long chain: a guard is independent of
// every other guard, and a failure should name itself instead of cascading.

const FUTURE_DAY = "2099-01-01";
const FUTURE_INSTANT = "2099-01-01T06:00:00Z";

Deno.test("a future date is refused wherever a record is written", async (t) => {
  await resetNutrition();

  // The two that corrupt silently. latestBodyfat() and the head of the trend
  // series are both "most recent row", so a slipped year outranks every
  // correct row after it and becomes the composition and the bodyweight the
  // calorie target is computed from.
  await t.step("body fat, which sets energy density", async () => {
    const { status, body } = await api.post("/bodyfat", {
      day: FUTURE_DAY,
      percent: 33,
      method: "visual",
    });
    assertEquals(status, 422);
    assert(body.error.includes("future"), body.error);
    assert(
      body.error.includes("year"),
      "the usual cause belongs in the message",
    );
  });

  await t.step("bodyweight, which sets the trend", async () => {
    const { status, body } = await api.post("/bodyweight", {
      value_kg: 75,
      measured_at: FUTURE_INSTANT,
    });
    assertEquals(status, 422);
    assert(body.error.includes("future"), body.error);
  });

  await t.step("intake and day flags", async () => {
    const intake = await api.post("/intake", {
      day: FUTURE_DAY,
      adhoc_kcal: 500,
    });
    assertEquals(intake.status, 422);
    assert(intake.body.error.includes("future"));

    const flag = await api.post(`/days/${FUTURE_DAY}/flags`, {
      flag: "incomplete",
    });
    assertEquals(flag.status, 422);
    assert(flag.body.error.includes("future"));
  });

  // The boundary the guard must not overshoot: today is not the future, and
  // today is where almost every real write lands.
  await t.step("today is still accepted", async () => {
    const bodyfat = await api.post("/bodyfat", {
      day: today(),
      percent: 14,
      method: "bia",
      request_id: uuid(),
    });
    assertEquals(bodyfat.status, 201);

    const intake = await api.post("/intake", {
      day: today(),
      adhoc_kcal: 500,
      request_id: uuid(),
    });
    assertEquals(intake.status, 201);
  });
});

Deno.test("an implausible bodyweight is refused", async (t) => {
  await resetNutrition();

  await t.step("a slipped decimal point", async () => {
    // 8.2 for 82.4. The EMA absorbs it without complaint and the trend it
    // feeds lands tens of kilos out — one row is enough.
    const { status, body } = await api.post("/bodyweight", { value_kg: 8.2 });
    assertEquals(status, 422);
    assert(body.error.includes("plausible"), body.error);
    assert(body.error.includes("decimal"), "name the cause, not just the rule");
  });

  await t.step("zero and absurdly heavy are refused too", async () => {
    assertEquals((await api.post("/bodyweight", { value_kg: 0 })).status, 422);
    assertEquals(
      (await api.post("/bodyweight", { value_kg: 500 })).status,
      422,
    );
  });

  await t.step("a real weigh-in passes untouched", async () => {
    const { status, body } = await api.post("/bodyweight", {
      value_kg: 82.4,
      measured_at: "2026-08-03T05:30:00Z",
    });
    assertEquals(status, 201);
    assertEquals(body.bodyweight.value_kg, 82.4);
  });
});

Deno.test("a number too large for its column is a prompt, not a 500", async () => {
  await resetNutrition();
  // Every measured column is a bounded numeric, so a misplaced decimal point
  // reaches Postgres rather than any validator. The override is here only to
  // get past the energy check — the point under test is what happens when the
  // value hits numeric(6,1).
  const { status, body } = await api.post("/foods", {
    name: "Overflowing Food",
    kcal_100g: 1234567,
    protein_100g: 10,
    carbs_100g: 10,
    fat_100g: 10,
    source: "estimate",
    energy_check: "override",
    source_note: "testing the column bound, not a real food",
    request_id: uuid(),
  });
  assertEquals(status, 422, `expected a prompt, got ${status}: ${body.error}`);
  assert(body.error.includes("too large"), body.error);
  assert(body.error.includes("decimal"), "say what usually causes it");
});

Deno.test("macros that outweigh the food are refused", async (t) => {
  await resetNutrition();

  await t.step("the energy check cannot see this one", async () => {
    // 90 + 50 + 30 implies exactly 830 kcal, so stating 830 satisfies the
    // energy identity perfectly while describing 170 g of macros in 100 g of
    // food. Scaling per-serving values keeps the identity intact — which is
    // why mass needs its own guard rather than a wider tolerance on energy.
    const { status, body } = await api.post("/foods", {
      name: "Impossible Bar",
      kcal_100g: 830,
      protein_100g: 90,
      carbs_100g: 50,
      fat_100g: 30,
      source: "label",
    });
    assertEquals(status, 422);
    assert(body.error.includes("100 g"), body.error);
  });

  await t.step("a correction cannot introduce one either", async () => {
    await api.post("/foods", {
      name: "Olive Oil",
      kcal_100g: 900,
      protein_100g: 0,
      carbs_100g: 0,
      fat_100g: 100,
      source: "crea",
      request_id: uuid(),
    });
    const { status } = await api.patch("/foods/Olive Oil", {
      protein_100g: 30,
      energy_check: "override",
      source_note: "still impossible whatever the energy says",
    });
    assertEquals(status, 422);
  });

  await t.step("pure fat at 100 g is not impossible", async () => {
    // The ceiling has rounding headroom on purpose: 100 g of fat per 100 g of
    // food is a real product, and a guard that rejected olive oil would be
    // worse than no guard.
    const { body } = await api.get("/foods/Olive Oil");
    assertEquals(body.food.fat_100g, 100);
  });
});

Deno.test("the energy tolerance is measured against the macros", async (t) => {
  await resetNutrition();
  // Which side the 15% is a percentage *of* is not cosmetic. Against the
  // stated figure the allowance grows with the very number under suspicion,
  // so the wronger a mis-scaled label is, the more room it gets — exactly
  // backwards. Against the implied energy the allowance is anchored to the
  // macros, which are the part being checked.
  //
  // The two are easy to confuse from the outside, because the 20 kcal floor
  // makes them agree on small foods. These cases are built so the floor
  // cannot bind: 100 g of carbs imply 400 kcal, so the allowance is 60.
  const bar = (kcal: number) => ({
    name: `Denominator Probe ${kcal}`,
    kcal_100g: kcal,
    protein_100g: 0,
    carbs_100g: 100,
    fat_100g: 0,
    source: "label",
    request_id: uuid(),
  });

  await t.step("inside 15% of the implied energy passes", async () => {
    assertEquals((await api.post("/foods", bar(460))).status, 201);
  });

  await t.step(
    "outside it fails, though it is within 15% of stated",
    async () => {
      // 461 against an implied 400 is 61 out: past the 60 allowed. Measured
      // against the stated 461 the allowance would be 69 and this would pass —
      // so this single case is what distinguishes the two readings.
      const { status, body } = await api.post("/foods", bar(461));
      assertEquals(status, 422);
      assert(body.error.includes("disagree"), body.error);
      assert(
        body.error.includes("400 kcal"),
        "the implied figure is the anchor",
      );
    },
  );

  await t.step("the floor carries near-zero foods regardless", async () => {
    // 0.1 g of protein implies 0.4 kcal; 2 kcal is five times that and still
    // fine, because 15% of almost nothing is not a usable allowance.
    const { status } = await api.post("/foods", {
      name: "Espresso",
      kcal_100g: 2,
      protein_100g: 0.1,
      carbs_100g: 0,
      fat_100g: 0,
      source: "crea",
      request_id: uuid(),
    });
    assertEquals(status, 201);
  });
});

Deno.test("an unused food deletes even when it carries aliases", async () => {
  await resetNutrition();
  // food_aliases references foods and nothing cascades, so the delete order
  // matters. Every food the coach saves with a synonym takes this path —
  // which is to say the previously covered case (a food with no aliases) was
  // the rarer one.
  const created = await api.post("/foods", {
    name: "Mistyped Yoghurt",
    kcal_100g: 57,
    protein_100g: 10,
    carbs_100g: 4,
    fat_100g: 0.2,
    source: "label",
    aliases: ["lo yogurt sbagliato"],
    request_id: uuid(),
  });
  assertEquals(created.status, 201);
  assertEquals(created.body.food.aliases.length, 1);

  const deleted = await api.delete("/foods/Mistyped Yoghurt");
  assertEquals(deleted.status, 200, deleted.body.error);
  assertEquals(deleted.body.deleted, "Mistyped Yoghurt");

  // The alias goes with it, so the word is free for the food that should own it.
  assertEquals((await api.get("/foods/lo yogurt sbagliato")).status, 422);
});

// The alias that is already taken says so by name, and says what holds it.
//
// The constraint underneath can only report that *an* alias collided: it does
// not know which of the several sent, nor what owns it. A coach sending two
// synonyms for a new product was told to go and search for the answer the
// server already had — and because the aliases are inserted in the same
// transaction as the row, that refusal threw away a fully sourced food.
Deno.test("a taken alias names itself and its owner", async (t) => {
  await resetNutrition();

  const classic = await api.post("/foods", {
    name: "Magnum Classic",
    brand: "Algida",
    kcal_100g: 300,
    protein_100g: 3.5,
    carbs_100g: 30,
    fat_100g: 19,
    grams_per_unit: 75,
    source: "label",
    aliases: ["magnum"],
    request_id: uuid(),
  });
  assertEquals(classic.status, 201, classic.body.error);

  await t.step(
    "the refusal names the alias and the food holding it",
    async () => {
      const { status, body } = await api.post("/foods", {
        name: "Magnum Pistacchio",
        brand: "Algida",
        kcal_100g: 330,
        protein_100g: 4,
        carbs_100g: 30,
        fat_100g: 22,
        grams_per_unit: 75,
        source: "label",
        aliases: ["magnum pistacchio", "magnum"],
        request_id: uuid(),
      });
      assertEquals(status, 409);
      assert(body.error.includes('"magnum"'), body.error);
      assert(body.error.includes("Magnum Classic"), body.error);
      assert(
        body.error.includes(String(classic.body.food.id)),
        `it should name the owning id: ${body.error}`,
      );
      // The free alias is not blamed for the taken one.
      assert(
        !body.error.includes('"magnum pistacchio"'),
        body.error,
      );
    },
  );

  await t.step("and the retry without it costs one word", async () => {
    const { status, body } = await api.post("/foods", {
      name: "Magnum Pistacchio",
      brand: "Algida",
      kcal_100g: 330,
      protein_100g: 4,
      carbs_100g: 30,
      fat_100g: 22,
      grams_per_unit: 75,
      source: "label",
      aliases: ["magnum pistacchio"],
      request_id: uuid(),
    });
    assertEquals(status, 201, body.error);
    assertEquals(body.food.aliases, ["magnum pistacchio"]);
  });

  // The same sentence from the other door, where the alias is added later.
  await t.step("adding one afterwards is refused the same way", async () => {
    const { status, body } = await api.post(
      "/foods/Magnum Pistacchio/aliases",
      { alias: "magnum" },
    );
    assertEquals(status, 409);
    assert(body.error.includes('"magnum"'), body.error);
    assert(body.error.includes("Magnum Classic"), body.error);
  });
});

Deno.test("a food correction reports only what it changed", async (t) => {
  await resetNutrition();
  await api.post("/foods", {
    name: "Brown Rice",
    kcal_100g: 111,
    protein_100g: 2.6,
    carbs_100g: 23,
    fat_100g: 0.9,
    source: "usda",
    request_id: uuid(),
  });
  await api.post("/intake", {
    food: "Brown Rice",
    grams: 200,
    request_id: uuid(),
  });

  await t.step("resending the same numbers corrects nothing", async () => {
    // Postgres returns numeric as text carrying its scale ("111.0") while the
    // incoming field is a JS number, so comparing them as strings called every
    // resend a change: entries were rewritten and the response claimed
    // corrections that never happened. The claim is the part that matters —
    // the coach reads it and tells Marco his record was wrong.
    const { status, body } = await api.patch("/foods/Brown Rice", {
      kcal_100g: 111,
      protein_100g: 2.6,
    });
    assertEquals(status, 200);
    assertEquals(body.corrected_entries.count, 0);
    assertEquals(body.corrected_entries.from, null);
    assert(body.note.includes("No macros changed"), body.note);
  });

  await t.step("a genuine correction still reaches the record", async () => {
    const { body } = await api.patch("/foods/Brown Rice", {
      kcal_100g: 362,
      protein_100g: 7.5,
      carbs_100g: 76,
      fat_100g: 2.7,
      source_note: "raw, not cooked — the original numbers were wrong",
    });
    assertEquals(body.corrected_entries.count, 1);
    assert(body.note.includes("Corrected 1 logged entry"));

    const after = await api.get("/intake");
    const entry = after.body.entries.find((e: { food: string }) =>
      e.food === "Brown Rice"
    );
    assertEquals(entry.kcal, 724); // 362 * 2
    assertEquals(entry.grams, 200, "the amount eaten never changed");
  });
});

Deno.test("every day field is a bare Rome date", async () => {
  await resetNutrition();
  // recent_days is built with generate_series, whose interval step yields
  // timestamp rather than date — so it slipped past the date parser in db.ts
  // and serialized as "2026-07-26T00:00:00.000Z" while /intake next to it
  // returned "2026-07-26". A coach formatting that instant locally gets the
  // wrong day either side of midnight.
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  const { body } = await api.get("/nutrition-state");

  assert(ISO_DAY.test(body.now.date), body.now.date);
  assertEquals(body.recent_days.length, 13);
  for (const row of body.recent_days) {
    assert(ISO_DAY.test(row.day), `recent_days carried ${row.day}`);
  }

  const intake = await api.get("/intake");
  assert(ISO_DAY.test(intake.body.day), intake.body.day);
});

Deno.test("an unlogged day reads null, not zero", async () => {
  await resetNutrition();
  // recent_days once coalesced kcal to 0 on days that were never logged —
  // beside a protein_g that stayed null in the same row. Two conventions in
  // one object, and the zero is the dangerous one: a floor of zeros under a
  // hasty average reads as fasting. Unknown is not zero; entries: 0 says
  // unlogged, and kcal must agree with it.
  const empty = await api.get("/nutrition-state");
  for (const row of empty.body.recent_days) {
    assertEquals(row.entries, 0);
    assertEquals(row.kcal, null, `${row.day} floored to ${row.kcal}`);
    assertEquals(row.protein_g, null);
  }

  // One logged day turns into numbers; its neighbours stay unknown.
  await api.post("/foods", {
    name: "Null Test Food",
    kcal_100g: 100,
    protein_100g: 5,
    carbs_100g: 12,
    fat_100g: 3,
    source: "estimate",
    source_note: "test fixture",
  });
  const logged = daysAgo(3);
  await api.post("/intake", {
    day: logged,
    food: "Null Test Food",
    grams: 250,
  });

  const { body } = await api.get("/nutrition-state");
  const byDay = new Map(
    body.recent_days.map((r: { day: string }) => [r.day, r]),
  );
  // deno-lint-ignore no-explicit-any
  const loggedRow = byDay.get(logged) as any;
  // deno-lint-ignore no-explicit-any
  const unloggedRow = byDay.get(daysAgo(4)) as any;
  assertEquals(loggedRow.kcal, 250);
  assertEquals(loggedRow.entries, 1);
  assertEquals(unloggedRow.kcal, null);
});

// A day can carry a flag having logged nothing, and that is the whole point of
// the flag: "I ate, I did not write it down." It is also the one day that
// exists in day_flags and not in intake_entries, which is why daily_intake
// draws its days from both tables rather than grouping the entries alone.
//
// Group the entries alone and this day has no row in the view, the left join
// below hands back null, and coalesce reports incomplete: false — turning "do
// not trust this day" into "this day was fine" without anything going red. The
// expenditure window would then take an untracked day as a real one, which is
// the reading the flag exists to prevent.
Deno.test("a day flagged with nothing logged still reports incomplete", async () => {
  await resetNutrition();
  const flagged = daysAgo(2);
  await api.post(`/days/${flagged}/flags`, { flag: "incomplete" });

  const { body } = await api.get("/nutrition-state");
  const row = body.recent_days.find((r: { day: string }) => r.day === flagged);
  assert(row !== undefined, `${flagged} is missing from recent_days entirely`);
  assertEquals(
    row.incomplete,
    true,
    "a flagged day with no entries reported as usable",
  );
  assertEquals(row.entries, 0);
  assertEquals(row.kcal, null);
});

// A field name nobody reads is the same failure as a number nobody checks.
//
// The case that produced this guard: the coach reasoned its way to a "scale"
// parameter for logging half a saved meal, sent it, and got a 201 over a
// whole breakfast. The field was dropped in silence, so the record said a
// full portion and nothing anywhere could tell that apart from one actually
// eaten. Every guard in this file exists because the wrong answer looked
// exactly like the right one; this is that shape arriving through the key.
Deno.test("an unrecognised field is refused, not dropped", async (t) => {
  await t.step("a guessed parameter names the ones that exist", async () => {
    const { status, body } = await api.post("/intake", {
      meal: "Colazione",
      portion: 0.5,
    });
    assertEquals(status, 422);
    assert(body.error.includes('"portion"'));
    // The prompt is the accepted list: usually all a caller needed.
    assert(body.error.includes("scale"), "it should offer the real name");
  });

  await t.step("a misspelling is caught the same way", async () => {
    const { status, body } = await api.post("/bodyweight", {
      value_kg: 82,
      measured_at: `${today()}T05:30:00Z`,
      sorce: "manual",
    });
    assertEquals(status, 422);
    assert(body.error.includes('"sorce"'));
    assert(body.error.includes("source"));
  });

  // Nested is where this matters most: one bad key among fifteen sets
  // answers 201 and simply is not in the record afterwards.
  await t.step("inside a nested entry too", async () => {
    const { status, body } = await api.post("/sessions", {
      date: today(),
      rationale: "checking the guard",
      sets: [{ exercise: "Back Squat", target_reps: 5, target_rpe: 8 }],
    });
    assertEquals(status, 422);
    assert(body.error.includes('"target_rpe"'));
    assert(body.error.includes("sets"), "it should say where it looked");
  });

  await t.step("request_id never has to be listed", async () => {
    const { status, body } = await api.postRaw("/blocks", {
      request_id: uuid(),
    });
    assertEquals(status, 422);
    assert(
      !body.error.includes("Unknown field"),
      `request_id is universal, but: ${body.error}`,
    );
  });
});

// The same rule on the other half of a request. docs/index states it without
// qualifying it to bodies, and for a long time only bodies kept it: a query
// string was filtered through a non-strict schema, so an unrecognised
// parameter was dropped and the call answered 200 with the unfiltered set.
Deno.test("an unrecognised query parameter is refused too", async (t) => {
  await t.step("on an endpoint that takes others", async () => {
    const { status, body } = await api.get("/sessions?from=2026-08-18");
    assertEquals(status, 422);
    assert(body.error.includes('"from"'), body.error);
    assert(body.error.includes("limit"), "it should list what is accepted");
    assert(body.error.includes("mesocycle"), body.error);
  });

  // The expensive one. GET /intake falls back to today when "day" is absent,
  // so a near miss on the name used to answer 200 with today's food under a
  // date the caller never asked about — a wrong answer shaped exactly like
  // the right one, which is worse than a refusal.
  await t.step("including the one that silently meant today", async () => {
    const { status, body } = await api.get("/intake?date=2026-08-28");
    assertEquals(status, 422);
    assert(body.error.includes('"date"'), body.error);
    assert(body.error.includes("day"), body.error);
  });

  await t.step("and on an endpoint that takes none at all", async () => {
    const { status, body } = await api.get("/nutrition-state?day=2026-08-28");
    assertEquals(status, 422);
    assert(body.error.includes('"day"'), body.error);
    assert(
      body.error.includes("no query parameters"),
      `it should say there are none: ${body.error}`,
    );
  });

  await t.step("a parameter that is accepted still works", async () => {
    const { status } = await api.get("/sessions?limit=1");
    assertEquals(status, 200);
  });

  // Number("abc") is NaN, and a NaN reaching Postgres as a limit throws where
  // the handler can only answer "internal error".
  await t.step("a limit that is not a number is a prompt", async () => {
    const { status, body } = await api.get("/sessions?limit=abc");
    assertEquals(status, 422);
    assert(body.error.includes("limit"), body.error);
  });
});

// Both state reads open with the server's clock, and the hour is part of it:
// a coach holding only a date cannot tell whether "stasera" at 23:40 means
// today or the day whose number is already one behind.
Deno.test("both state reads say what time it is", async (t) => {
  for (const path of ["/nutrition-state", "/training-state"]) {
    await t.step(path, async () => {
      const { status, body } = await api.get(path);
      assertEquals(status, 200);
      assertEquals(body.now.date, today());
      assertEquals(body.now.tz, "Europe/Rome");
      assert(/^\d{2}:\d{2}$/.test(body.now.time), body.now.time);
      assert(
        /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/.test(body.now.weekday),
        body.now.weekday,
      );
      assertEquals(Object.keys(body)[0], "now", "it is the first key");
    });
  }
});
