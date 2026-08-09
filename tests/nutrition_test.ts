import { assert, assertEquals } from "@std/assert";
import { api, resetNutrition, today, uuid } from "./helpers.ts";

Deno.test("nutrition tracking", async (t) => {
  await resetNutrition();

  const yogurt = {
    name: "Greek Yogurt 0%",
    brand: "Fage",
    kcal_100g: 57,
    protein_100g: 10.3,
    carbs_100g: 4,
    fat_100g: 0.2,
    source: "label",
    aliases: ["yogurt greco", "il solito yogurt"],
  };

  await t.step("a food is saved once, with its aliases", async () => {
    const { status, body } = await api.post("/foods", {
      ...yogurt,
      request_id: uuid(),
    });
    assertEquals(status, 201);
    assertEquals(body.food.name, "Greek Yogurt 0%");
    assertEquals(body.food.aliases, ["il solito yogurt", "yogurt greco"]);
  });

  await t.step("it resolves by name and by alias, any case", async () => {
    const byName = await api.get("/foods/Greek%20Yogurt%200%25");
    assertEquals(byName.status, 200);
    const byAlias = await api.get("/foods/IL%20SOLITO%20YOGURT");
    assertEquals(byAlias.status, 200);
    assertEquals(byAlias.body.food.id, byName.body.food.id);
  });

  await t.step(
    "a duplicate food is refused, a synonym redirected",
    async () => {
      const { status, body } = await api.post("/foods", {
        ...yogurt,
        name: "greek yogurt 0%",
      });
      assertEquals(status, 409);
      assert(body.error.includes("aliases"));
    },
  );

  await t.step("an unknown food says how to source one", async () => {
    const { status, body } = await api.get("/foods/pastiera");
    assertEquals(status, 422);
    assert(body.error.includes("never invented"));
  });

  await t.step("macros that outrun the stated energy are refused", async () => {
    // Per-serving macros pasted against a per-100g energy: the classic error.
    const { status, body } = await api.post("/foods", {
      name: "Mis-scaled Bar",
      kcal_100g: 120,
      protein_100g: 20,
      carbs_100g: 40,
      fat_100g: 10,
      source: "label",
    });
    assertEquals(status, 422);
    assert(body.error.includes("disagree"));
    assert(body.error.includes("sugar alcohols"));
  });

  await t.step("a real sugar-free label can still be saved", async () => {
    // EU labelling counts polyols inside the carbohydrate figure but only
    // credits them ~2.4 kcal/g in the energy line, so a correct label
    // overshoots the 4/4/9 identity by ~50%. Without a symmetric override
    // every sugar-free product would be unloggable.
    const bar = {
      name: "Sugar-Free Maltitol Bar",
      kcal_100g: 240,
      protein_100g: 5,
      carbs_100g: 90,
      fat_100g: 1,
      source: "label",
    };
    const refused = await api.post("/foods", bar);
    assertEquals(refused.status, 422);
    assert(refused.body.error.includes("sugar alcohols"));

    const accepted = await api.post("/foods", {
      ...bar,
      energy_check: "override",
      source_note: "90 g of maltitol, counted as carbs but ~2.4 kcal/g",
      request_id: uuid(),
    });
    assertEquals(accepted.status, 201);
    assertEquals(accepted.body.food.kcal_100g, 240);
  });

  await t.step("unexplained energy needs a stated reason", async () => {
    const beer = {
      name: "Lager 5%",
      kcal_100g: 43,
      protein_100g: 0.5,
      carbs_100g: 3.6,
      fat_100g: 0,
      source: "off",
    };
    const refused = await api.post("/foods", beer);
    assertEquals(refused.status, 422);
    assert(refused.body.error.includes("alcohol"));

    const noNote = await api.post("/foods", {
      ...beer,
      energy_check: "override",
    });
    assertEquals(noNote.status, 422);
    assert(noNote.body.error.includes("source_note"));

    const accepted = await api.post("/foods", {
      ...beer,
      energy_check: "override",
      source_note: "alcohol carries the balance at 7 kcal/g",
      request_id: uuid(),
    });
    assertEquals(accepted.status, 201);
  });

  await t.step("near-zero foods pass on the absolute floor", async () => {
    const { status } = await api.post("/foods", {
      name: "Black Coffee",
      kcal_100g: 2,
      protein_100g: 0.1,
      carbs_100g: 0,
      fat_100g: 0,
      source: "crea",
      request_id: uuid(),
    });
    assertEquals(status, 201);
  });

  await t.step("a food eaten in pieces converts units to grams", async () => {
    await api.post("/foods", {
      name: "Egg",
      kcal_100g: 143,
      protein_100g: 12.6,
      carbs_100g: 0.7,
      fat_100g: 9.5,
      grams_per_unit: 55,
      source: "usda",
      request_id: uuid(),
    });
    const { status, body } = await api.post("/intake", {
      food: "egg",
      units: 2,
      request_id: uuid(),
    });
    assertEquals(status, 201);
    const egg = body.entries.find((e: { food: string }) => e.food === "Egg");
    assertEquals(egg.grams, 110);
    assertEquals(egg.kcal, 157.3); // 143 * 1.10
  });

  await t.step("a food with no grams_per_unit refuses units", async () => {
    const { status, body } = await api.post("/intake", {
      food: "Black Coffee",
      units: 1,
    });
    assertEquals(status, 422);
    assert(body.error.includes("grams_per_unit"));
  });

  let breakfastId = 0;

  await t.step("a meal is created whole, with computed totals", async () => {
    await api.post("/foods", {
      name: "Honey",
      kcal_100g: 304,
      protein_100g: 0.3,
      carbs_100g: 82.4,
      fat_100g: 0,
      source: "crea",
      request_id: uuid(),
    });
    const { status, body } = await api.post("/meals", {
      name: "Colazione",
      aliases: ["la solita colazione"],
      items: [
        { food: "il solito yogurt", grams: 200 },
        { food: "Honey", grams: 20 },
      ],
      request_id: uuid(),
    });
    assertEquals(status, 201);
    breakfastId = body.meal.id;
    assertEquals(body.meal.items.length, 2);
    // 57*2 + 304*0.2 = 114 + 60.8
    assertEquals(body.meal.totals.kcal, 174.8);
    assertEquals(body.meal.totals.protein_g, 20.7);
  });

  await t.step("logging a meal writes one row per food", async () => {
    const { status, body } = await api.post("/intake", {
      meal: "la solita colazione",
      request_id: uuid(),
    });
    assertEquals(status, 201);
    const fromMeal = body.entries.filter(
      (e: { meal_id: number | null }) => e.meal_id === breakfastId,
    );
    assertEquals(fromMeal.length, 2);
    assertEquals(
      fromMeal.every((e: { meal: string }) => e.meal === "Colazione"),
      true,
    );
  });

  await t.step("a different product is a new food, not an edit", async () => {
    // The rule that makes retroactive food correction safe. A reformulated or
    // rebranded yogurt is a different thing, so it gets its own row and the
    // breakfast already logged keeps the numbers it was logged with. Editing
    // the original would have meant "these numbers were always wrong", which
    // here they were not.
    const logged = await api.get("/intake");
    const before = logged.body.entries.find(
      (e: { food: string; meal_id: number | null }) =>
        e.food === "Greek Yogurt 0%" && e.meal_id === breakfastId,
    );
    assertEquals(before.kcal, 114);

    await api.post("/foods", {
      name: "Greek Yogurt 0% (new recipe)",
      kcal_100g: 71,
      protein_100g: 9,
      carbs_100g: 5,
      fat_100g: 1.5,
      source: "label",
      request_id: uuid(),
    });

    const after = await api.get("/intake");
    const still = after.body.entries.find(
      (e: { food: string; meal_id: number | null }) =>
        e.food === "Greek Yogurt 0%" && e.meal_id === breakfastId,
    );
    assertEquals(still.kcal, 114);
  });

  await t.step("editing a meal changes future logs only", async () => {
    // The other half of the snapshot promise: the recipe evolves, history
    // does not. Honey doubles; the breakfast already logged keeps 60.8 kcal
    // of honey, and the next log gets 121.6.
    const before = await api.get("/intake");
    const loggedHoney = before.body.entries.find(
      (e: { food: string }) => e.food === "Honey",
    );
    assertEquals(loggedHoney.kcal, 60.8);

    const edited = await api.patch("/meals/Colazione", {
      items: [
        { food: "il solito yogurt", grams: 200 },
        { food: "Honey", grams: 40 },
      ],
    });
    assertEquals(edited.status, 200);
    assertEquals(edited.body.meal.totals.kcal, 235.6);

    const after = await api.get("/intake");
    const stillLogged = after.body.entries.find(
      (e: { food: string }) => e.food === "Honey",
    );
    assertEquals(stillLogged.kcal, 60.8, "history must not move");

    await api.post("/intake", { meal: "Colazione", request_id: uuid() });
    const relogged = await api.get("/intake");
    const fresh = relogged.body.entries.filter(
      (e: { food: string }) => e.food === "Honey",
    );
    assertEquals(fresh.some((e: { kcal: number }) => e.kcal === 121.6), true);
  });

  await t.step("a past entry is corrected explicitly", async () => {
    const day = await api.get("/intake");
    const egg = day.body.entries.find((e: { food: string }) =>
      e.food === "Egg"
    );

    // Re-scaling from the food: three eggs, not two.
    const rescaled = await api.patch(`/intake/${egg.id}`, { grams: 165 });
    assertEquals(rescaled.status, 200);
    const fixed = rescaled.body.entries.find(
      (e: { id: number }) => e.id === egg.id,
    );
    assertEquals(fixed.grams, 165);
    assertEquals(fixed.kcal, 236);

    // A duplicate log is removed, not zeroed: a 0 kcal row would still count
    // as a logged entry and inflate adherence.
    const removed = await api.delete(`/intake/${egg.id}`);
    assertEquals(removed.status, 200);
    assertEquals(
      removed.body.entries.some((e: { id: number }) => e.id === egg.id),
      false,
    );
  });

  await t.step("an ad-hoc entry cannot re-scale from a food", async () => {
    const adhoc = await api.post("/intake", {
      adhoc_kcal: 300,
      note: "gelato",
      request_id: uuid(),
    });
    const entry = adhoc.body.entries.find(
      (e: { note: string | null }) => e.note === "gelato",
    );
    const refused = await api.patch(`/intake/${entry.id}`, { grams: 100 });
    assertEquals(refused.status, 422);
    assert(refused.body.error.includes("ad-hoc"));

    const corrected = await api.patch(`/intake/${entry.id}`, { kcal: 250 });
    assertEquals(corrected.status, 200);
    assertEquals(
      corrected.body.entries.find((e: { id: number }) => e.id === entry.id)
        .kcal,
      250,
    );
    await api.delete(`/intake/${entry.id}`);
  });

  await t.step("an ad-hoc day is a first-class entry", async () => {
    const { status, body } = await api.post("/intake", {
      adhoc_kcal: 1200,
      note: "pizza and a beer out",
      request_id: uuid(),
    });
    assertEquals(status, 201);
    const adhoc = body.entries.find(
      (e: { note: string | null }) => e.note === "pizza and a beer out",
    );
    assertEquals(adhoc.food_id, null);
    assertEquals(adhoc.grams, null);
    assertEquals(adhoc.kcal, 1200);
  });

  await t.step("totals report what they do not cover, per macro", async () => {
    const { body } = await api.get("/intake");
    // Only the ad-hoc entry is silent about protein, so protein is a floor
    // over 1200 unlogged kcal — that is the number the coach must not read
    // as "Marco ate 30 g of protein today".
    assertEquals(body.totals.unaccounted.protein_g, { entries: 1, kcal: 1200 });
    assert(body.totals.kcal > 1200);
    assertEquals(typeof body.totals.protein_g, "number");

    // Fibre is missing from every food here, so its total is null rather than
    // a confident zero — and the fibre gap does not contaminate protein's.
    assertEquals(body.totals.fiber_g, null);
    assert(body.totals.unaccounted.fiber_g.entries > 1);
  });

  await t.step("exactly one of meal, food, adhoc_kcal", async () => {
    const none = await api.post("/intake", {});
    assertEquals(none.status, 422);
    const both = await api.post("/intake", {
      food: "Honey",
      grams: 10,
      adhoc_kcal: 100,
    });
    assertEquals(both.status, 422);
    assert(both.body.error.includes("exactly one"));
  });

  await t.step("retrying a logged meal changes nothing", async () => {
    const id = uuid();
    const first = await api.post("/intake", {
      meal: "Colazione",
      request_id: id,
    });
    assertEquals(first.status, 201);
    const count = first.body.entries.length;
    const retry = await api.post("/intake", {
      meal: "Colazione",
      request_id: id,
    });
    assertEquals(retry.status, 200);
    assertEquals(retry.body.entries.length, count);
  });

  await t.step("a day is flagged incomplete, and unflagged", async () => {
    const day = today();
    const flagged = await api.post(`/days/${day}/flags`, {
      flag: "incomplete",
    });
    assertEquals(flagged.status, 201);
    assertEquals(flagged.body.flags, ["incomplete"]);

    const bad = await api.post(`/days/${day}/flags`, { flag: "lazy" });
    assertEquals(bad.status, 422);

    const cleared = await api.delete(`/days/${day}/flags/incomplete`);
    assertEquals(cleared.status, 200);
    assertEquals(cleared.body.flags, []);
  });

  await t.step("body fat dedupes on day and method", async () => {
    const estimate = { day: today(), percent: 14.5, method: "bia" };
    const first = await api.post("/bodyfat", {
      ...estimate,
      request_id: uuid(),
    });
    assertEquals(first.status, 201);
    const retry = await api.post("/bodyfat", estimate);
    assertEquals(retry.status, 200);
    const conflicting = await api.post("/bodyfat", {
      ...estimate,
      percent: 16,
    });
    assertEquals(conflicting.status, 409);
  });

  await t.step("a food correction reaches everything logged", async () => {
    // The other half of the snapshot rule. A meal's recipe changing means
    // Marco ate differently, so history stands. A food's numbers changing
    // means they were always wrong — that is an error, not history.
    const rice = await api.post("/foods", {
      name: "White Rice",
      kcal_100g: 130,
      protein_100g: 2.7,
      carbs_100g: 28,
      fat_100g: 0.3,
      source: "usda",
    });
    assertEquals(rice.status, 201);
    await api.post("/intake", { food: "White Rice", grams: 200 });

    const before = await api.get("/intake");
    const cooked = before.body.entries.find((e: { food: string }) =>
      e.food === "White Rice"
    );
    assertEquals(cooked.kcal, 260);

    // Those were the cooked-rice numbers; the label is raw.
    const fixed = await api.patch("/foods/White Rice", {
      kcal_100g: 360,
      protein_100g: 6.6,
      carbs_100g: 80,
      fat_100g: 0.6,
      source_note: "raw, not cooked — the original numbers were wrong",
    });
    assertEquals(fixed.status, 200);
    assertEquals(fixed.body.corrected_entries.count, 1);
    assert(fixed.body.note.includes("Corrected 1 logged entry"));

    const after = await api.get("/intake");
    const corrected = after.body.entries.find((e: { food: string }) =>
      e.food === "White Rice"
    );
    assertEquals(corrected.kcal, 720); // 360 * 2
    assertEquals(corrected.grams, 200, "the amount eaten never changed");
  });

  await t.step("a correction still cannot break the energy check", async () => {
    const { status, body } = await api.patch("/foods/White Rice", {
      kcal_100g: 50,
    });
    assertEquals(status, 422);
    assert(body.error.includes("disagree"));
  });

  await t.step("an alias moves between foods", async () => {
    await api.post("/foods/White Rice/aliases", { alias: "riso" });
    const taken = await api.post("/foods/Honey/aliases", { alias: "riso" });
    assertEquals(taken.status, 409);

    const removed = await api.delete("/foods/White Rice/aliases/riso");
    assertEquals(removed.status, 200);
    assertEquals(removed.body.food.aliases.includes("riso"), false);

    const moved = await api.post("/foods/Honey/aliases", { alias: "riso" });
    assertEquals(moved.status, 201);
  });

  await t.step("a used food cannot be deleted, an unused one can", async () => {
    const used = await api.delete("/foods/White Rice");
    assertEquals(used.status, 409);
    assert(used.body.error.includes("PATCH"));

    await api.post("/foods", {
      name: "Typo Foodd",
      kcal_100g: 100,
      protein_100g: 5,
      carbs_100g: 10,
      fat_100g: 3,
      source: "estimate",
    });
    const unused = await api.delete("/foods/Typo Foodd");
    assertEquals(unused.status, 200);
    assertEquals((await api.get("/foods/Typo Foodd")).status, 422);
  });

  await t.step("a meal is retired by taking its aliases away", async () => {
    // Meals are never deleted — the logged rows point at them. Retiring one
    // frees the word Marco actually says so a replacement can claim it.
    const freed = await api.delete(
      "/meals/Colazione/aliases/la solita colazione",
    );
    assertEquals(freed.status, 200);
    assertEquals(freed.body.meal.aliases.length, 0);
    assertEquals((await api.delete("/meals/Colazione")).status, 404);

    const reused = await api.post("/meals", {
      name: "Colazione nuova",
      aliases: ["la solita colazione"],
      items: [{ food: "Honey", grams: 30 }],
    });
    assertEquals(reused.status, 201);
  });

  await t.step("a mistyped measurement can be removed", async () => {
    const bad = await api.post("/bodyweight", {
      value_kg: 128.4, // meant 82.4
      measured_at: "2026-08-03T06:00:00Z",
    });
    assertEquals(bad.status, 201);
    const gone = await api.delete(`/bodyweight/${bad.body.bodyweight.id}`);
    assertEquals(gone.status, 200);
    assertEquals(gone.body.deleted.value_kg, 128.4);
    assertEquals((await api.get("/bodyweight")).body.bodyweight.length, 0);
  });

  await t.step("request_id is required, not merely accepted", async () => {
    const without = await api.postRaw("/intake", { adhoc_kcal: 100 });
    assertEquals(without.status, 422);
    assert(without.body.error.includes("retry"));

    // And it still does its job when sent.
    const id = uuid();
    const first = await api.postRaw("/intake", {
      adhoc_kcal: 100,
      request_id: id,
    });
    assertEquals(first.status, 201);
    const count = first.body.entries.length;
    const retry = await api.postRaw("/intake", {
      adhoc_kcal: 100,
      request_id: id,
    });
    assertEquals(retry.body.entries.length, count);
  });

  await t.step("a malformed id is a prompt, not a 500", async () => {
    for (
      const call of [
        api.delete("/intake/notanid"),
        api.patch("/intake/notanid", { kcal: 1 }),
        api.delete("/bodyfat/notanid"),
        api.delete("/nutrition-events/notanid"),
        api.delete("/bodyweight/notanid"),
      ]
    ) {
      const { status, body } = await call;
      assertEquals(status, 422);
      assert(body.error.includes("is not a valid"), body.error);
    }
  });

  await t.step("nutrition-state is honest with no history", async () => {
    // Today's logging exists but there is no weight series and no target, so
    // everything derived from those must be absent rather than defaulted.
    const { status, body } = await api.get("/nutrition-state");
    assertEquals(status, 200);
    assertEquals(body.today, today());
    assert(body.today_so_far.entries.length > 0);
    assert(body.today_so_far.totals.kcal > 0);
    assertEquals(body.today_so_far.vs_target, null);
    assertEquals(body.trend_weight, null);
    assertEquals(body.target, null);
    assertEquals(body.expenditure.status, "insufficient_data");
    assertEquals(body.expenditure.tdee_kcal, null);
    // No estimate, so nothing to date-stamp: a date beside a null tdee reads
    // as "current as of" and implies a number exists.
    assertEquals(body.expenditure.as_of, null);
    // Every unmet condition at once, not the first one hit. Body fat is on
    // record by this point in the file, so the blockers here are the logging
    // and weigh-in ones; the both-at-once case is covered as a unit test.
    assert(body.expenditure.blockers.length >= 2);
    assert(
      body.expenditure.blockers.some((b: string) =>
        b.includes("logged intake")
      ),
    );
    assert(
      body.expenditure.blockers.some((b: string) => b.includes("weigh-in day")),
    );
    assert(
      body.expenditure.blockers.some((b: string) => b.includes("21")),
      "the window length belongs in the message, not just the docs",
    );
    assertEquals(body.latest_bodyfat.percent, 14.5);
    assertEquals(typeof body.adherence.days_logged_last_7, "number");
    assertEquals(typeof body.adherence.weigh_ins_last_7, "number");
  });

  // The two adherence numbers about weighing must be able to agree. They could
  // not: the count stopped before today and last_weigh_in did not, so a scale
  // that reported this morning produced "no weigh-ins in the last seven days,
  // most recently today". A coach hit exactly that pair and reported the sync
  // as broken.
  await t.step("a weigh-in today counts as one, and says so", async () => {
    await resetNutrition();
    const { status } = await api.post("/bodyweight", {
      value_kg: 72.66,
      measured_at: new Date().toISOString(),
    });
    assertEquals(status, 201);

    const { body } = await api.get("/nutrition-state");
    assertEquals(body.adherence.weigh_ins_last_7, 1);
    assertEquals(body.adherence.weigh_ins_last_21, 1);
    assertEquals(body.adherence.last_weigh_in, body.today);
  });
});
