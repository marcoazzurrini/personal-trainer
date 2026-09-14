import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  api,
  ensureCatalogue,
  resetNutrition,
  resetTraining,
  today,
  uuid,
} from "./helpers.ts";

// helpers verifies the disposable database before these modules can write.
Deno.test("routine registry writes keep their atomic and historical boundaries", async (t) => {
  const { sql } = await import("../db.ts");
  const { addAliases } = await import("../shared/aliases.ts");
  const { exerciseById } = await import("../training/exercises.ts");
  const { hashToken, issueToken, verifyToken } = await import(
    "../access/tokens.ts"
  );

  async function food(name: string, aliases: string[] = []) {
    const created = await api.post("/foods", {
      name,
      aliases,
      kcal_100g: 100,
      protein_100g: 5,
      carbs_100g: 15,
      fat_100g: 2,
      source: "label",
    });
    assertEquals(created.status, 201, created.body.error);
    return created.body.food.id as number;
  }

  try {
    await t.step(
      "mint survives cleanup failure without logging token material",
      async () => {
        const expired = uuid();
        const expiredHash = await hashToken(expired);
        await sql`
        insert into api_tokens (token_hash, subject, issued_at, expires_at)
        values (${expiredHash}, 'expired-test', now() - interval '2 days', now() - interval '1 day')`;
        const messages: unknown[][] = [];
        const originalError = console.error;
        try {
          await sql`create function test_token_cleanup_failure() returns trigger language plpgsql as $$
          begin
            raise exception 'sensitive database details must not be logged';
          end $$`;
          await sql`create trigger test_token_cleanup_failure before delete on api_tokens
          for each statement execute function test_token_cleanup_failure()`;
          console.error = (...args: unknown[]) => {
            messages.push(args);
          };
          const minted = await issueToken("user_test");
          assertEquals(await verifyToken(minted.token), {
            subject: "user_test",
          });
          assertEquals((await api.get("/exercises", minted.token)).status, 200);
          assertEquals(await verifyToken(expired), null);
          assertEquals(messages, [["Expired API token cleanup failed."]]);
          assertEquals(
            (await sql`select token_hash from api_tokens where token_hash = ${expiredHash}`)
              .length,
            1,
          );
          await sql`drop trigger test_token_cleanup_failure on api_tokens`;
          await issueToken("user_test");
          assertEquals(
            (await sql`select token_hash from api_tokens where token_hash = ${expiredHash}`)
              .length,
            0,
          );
          assertEquals(await verifyToken(minted.token), {
            subject: "user_test",
          });

          await sql`create function test_token_mint_failure() returns trigger language plpgsql as $$
          begin
            raise exception 'injected mint failure';
          end $$`;
          await sql`create trigger test_token_mint_failure before insert on api_tokens
          for each statement execute function test_token_mint_failure()`;
          const [{ n: before }] =
            await sql`select count(*)::int as n from api_tokens`;
          await assertRejects(
            () => issueToken("user_test"),
            Error,
            "injected mint failure",
          );
          assertEquals(
            (await sql`select count(*)::int as n from api_tokens`)[0].n,
            before,
          );
          assertEquals(messages.length, 1);
        } finally {
          console.error = originalError;
          await sql`drop trigger if exists test_token_cleanup_failure on api_tokens`;
          await sql`drop function if exists test_token_cleanup_failure()`;
          await sql`drop trigger if exists test_token_mint_failure on api_tokens`;
          await sql`drop function if exists test_token_mint_failure()`;
        }
      },
    );

    await t.step(
      "every alias table accepts a batch or none of it",
      async () => {
        // Scratch exercises must not stop later suites from loading the catalogue.
        await ensureCatalogue();
        await resetNutrition();
        const foodId = await food("Alias batch food");
        const exercise = await api.post("/exercises", {
          name: `Alias batch ${uuid()}`,
          measure: "reps",
        });
        assertEquals(exercise.status, 201);
        const meal = await api.post("/meals", {
          name: "Alias batch meal",
          items: [{ food: foodId, grams: 40 }],
        });
        assertEquals(meal.status, 201);
        for (
          const [table, foreignKey, id] of [
            ["food_aliases", "food_id", foodId],
            ["exercise_aliases", "exercise_id", exercise.body.exercise.id],
            ["meal_aliases", "meal_id", meal.body.meal.id],
          ] as const
        ) {
          const alias = `batch-${uuid()}`;
          await assertRejects(() =>
            addAliases(table, foreignKey, id, [alias, alias.toUpperCase()])
          );
          assertEquals(
            (await sql`select id from ${sql(table)} where ${
              sql(foreignKey)
            } = ${id}`).length,
            0,
          );
          await addAliases(table, foreignKey, id, []);
          await addAliases(table, foreignKey, id, [alias, `${alias}-second`]);
          assertEquals(
            (await sql`select id from ${sql(table)} where ${
              sql(foreignKey)
            } = ${id}`).length,
            2,
          );
        }
      },
    );

    await t.step(
      "exercise children roll back with creation and reclassification",
      async () => {
        await resetTraining();
        const muscle = `Bulk muscle ${uuid()}`;
        assertEquals(
          (await api.post("/muscles", { name: muscle })).status,
          201,
        );
        const name = `Bulk exercise ${uuid()}`;
        const aliases = [`bulk-${uuid()}`, `bulk-${uuid()}`];
        const muscles = [{ muscle, volume_factor: 1 }, {
          muscle: muscle.toUpperCase(),
          volume_factor: 0.5,
        }];
        const failed = await api.post("/exercises", {
          name,
          aliases,
          measure: "reps",
          muscles,
        });
        assertEquals(failed.status, 409);
        assertEquals(
          (await sql`select id from exercises where name = ${name}`).length,
          0,
        );
        assertEquals(
          (await sql`select id from exercise_aliases where alias in ${
            sql(aliases)
          }`).length,
          0,
        );
        const unknown = await api.post("/exercises", {
          name,
          aliases,
          measure: "reps",
          muscles: [muscles[0], {
            muscle: "missing bulk muscle",
            volume_factor: 1,
          }],
        });
        assertEquals(unknown.status, 422);
        assert(
          unknown.body.error.includes('Unknown muscle "missing bulk muscle"'),
        );
        assertEquals(
          (await sql`select id from exercises where name = ${name}`).length,
          0,
        );
        const created = await api.post("/exercises", {
          name,
          aliases,
          measure: "reps",
          muscles: [muscles[0]],
        });
        assertEquals(created.status, 201);
        assertEquals(created.body.exercise.aliases.length, 2);
        const id = created.body.exercise.id;
        const replacement = await api.put(`/exercises/${id}/muscles`, {
          muscles,
        });
        assertEquals(replacement.status, 409);
        assertEquals(
          await exerciseById(id),
          created.body.exercise,
        );
        assertEquals((await api.delete(`/exercises/${id}`)).status, 200);
        assertEquals(
          (await sql`select id from exercise_aliases where exercise_id = ${id}`)
            .length,
          0,
        );
        assertEquals(
          (await sql`select id from exercise_muscles where exercise_id = ${id}`)
            .length,
          0,
        );
        assertEquals(
          (await sql`select id from muscles where name = ${muscle}`).length,
          1,
        );
      },
    );

    await t.step(
      "food deletion cascades aliases but never meal items or intake",
      async () => {
        await resetNutrition();
        const unused = await food("Unused cascade food", [
          "unused cascade alias",
        ]);
        // Direct parent DELETE proves the FK, not a service's manual cleanup.
        await sql`delete from foods where id = ${unused}`;
        assertEquals(
          (await sql`select id from food_aliases where food_id = ${unused}`)
            .length,
          0,
        );
        const recipeFood = await food("Recipe protected food", [
          "recipe protected alias",
        ]);
        const loggedFood = await food("Intake protected food", [
          "intake protected alias",
        ]);
        assertEquals(
          (await api.post("/meals", {
            name: "Protected recipe",
            items: [{ food: recipeFood, grams: 50 }],
          })).status,
          201,
        );
        assertEquals(
          (await api.post("/intake", {
            day: today(),
            food: loggedFood,
            grams: 100,
          })).status,
          201,
        );
        const items = [...await sql`select * from meal_items order by id`];
        const intake = [...await sql`select * from intake_entries order by id`];
        for (const id of [recipeFood, loggedFood]) {
          const error = await assertRejects(async () => {
            await sql`delete from foods where id = ${id}`;
          });
          assertEquals((error as { code: string }).code, "23503");
          assertEquals(
            (await sql`select id from foods where id = ${id}`).length,
            1,
          );
          assertEquals(
            (await sql`select id from food_aliases where food_id = ${id}`)
              .length,
            1,
          );
        }
        assertEquals(
          [...await sql`select * from meal_items order by id`],
          items,
        );
        assertEquals(
          [...await sql`select * from intake_entries order by id`],
          intake,
        );
      },
    );

    await t.step(
      "exercise history still blocks the parent DELETE and keeps auxiliaries",
      async () => {
        await resetTraining();
        const muscle = `History muscle ${uuid()}`;
        assertEquals(
          (await api.post("/muscles", { name: muscle })).status,
          201,
        );
        const created = await api.post("/exercises", {
          name: `History exercise ${uuid()}`,
          measure: "reps",
          aliases: [`history-${uuid()}`],
          muscles: [{ muscle, volume_factor: 1 }],
        });
        assertEquals(created.status, 201);
        const id = created.body.exercise.id;
        assertEquals(
          (await api.post("/sessions", {
            date: today(),
            rationale: "Keep history",
            sets: [{ exercise: id, reps: 8, effort: "hard" }],
          })).status,
          201,
        );
        const sets = [
          ...await sql`select * from sets where exercise_id = ${id}`,
        ];
        const refused = await api.delete(`/exercises/${id}`);
        assertEquals(refused.status, 409);
        assert(refused.body.error.includes("1 logged set"));
        const error = await assertRejects(async () => {
          await sql`delete from exercises where id = ${id}`;
        });
        assertEquals((error as { code: string }).code, "23503");
        assertEquals([
          ...await sql`select * from sets where exercise_id = ${id}`,
        ], sets);
        assertEquals(
          await exerciseById(id),
          created.body.exercise,
        );
        const restrictions = await sql`
        select conname, confdeltype from pg_constraint
        where conname in ('sets_exercise_id_fkey', 'mesocycle_exercises_exercise_id_fkey',
          'mesocycle_exercise_doses_exercise_id_fkey', 'meal_items_food_id_fkey',
          'intake_entries_food_id_fkey') order by conname`;
        assertEquals(restrictions.length, 5);
        assert(
          restrictions.every((row) =>
            row.confdeltype === "a" || row.confdeltype === "r"
          ),
        );
      },
    );
  } finally {
    await sql.end();
  }
});
