import { test } from "node:test";

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "./assertions.ts";
import {
  api,
  ensureCatalogue,
  resetNutrition,
  resetTraining,
  today,
  uuid,
} from "./helpers.ts";
// helpers verifies the disposable database before these modules can write.
test("routine registry writes keep their atomic and historical boundaries", async (t) => {
  const { default: d1, database } = await import("./d1.ts");
  const sql = d1();
  const { createServices } = await import("../services.ts");
  const services = createServices(database);
  const { exerciseById } = services.exercises;
  const { hashToken } = await import("../access/tokens.ts");
  const { issueToken, verifyToken } = services.tokens;
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
    const { id } = created.body.food;
    assert(typeof id === "number");
    return id;
  }
  try {
    await t.test(
      "mint survives cleanup failure without logging token material",
      async () => {
        const expired = uuid();
        const expiredHash = await hashToken(expired);
        await sql`
        insert into api_tokens (token_hash, subject, issued_at, expires_at)
        values (${expiredHash}, 'expired-test', strftime('%Y-%m-%dT%H:%M:%f', 'now', '-2 days') || '000Z', strftime('%Y-%m-%dT%H:%M:%f', 'now', '-1 day') || '000Z')`;
        const messages: unknown[][] = [];
        const originalError = console.error;
        try {
          await sql`CREATE TRIGGER test_token_cleanup_failure BEFORE DELETE ON api_tokens
          BEGIN SELECT RAISE(ABORT, 'sensitive database details must not be logged'); END`;
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
            (
              await sql`select token_hash from api_tokens where token_hash = ${expiredHash}`
            ).length,
            1
          );
          await sql`drop trigger test_token_cleanup_failure`;
          await issueToken("user_test");
          assertEquals(
            (
              await sql`select token_hash from api_tokens where token_hash = ${expiredHash}`
            ).length,
            0
          );
          assertEquals(await verifyToken(minted.token), {
            subject: "user_test",
          });
          await sql`CREATE TRIGGER test_token_mint_failure BEFORE INSERT ON api_tokens
          BEGIN SELECT RAISE(ABORT, 'injected mint failure'); END`;
          const [{ n: before }] =
            await sql`select count(*) as n from api_tokens`;
          const failure = await assertRejects(() => issueToken("user_test"));
          // Drizzle retains native failures as causes, not in its query message.
          assert(failure.cause instanceof Error);
          assertStringIncludes(failure.cause.message, "injected mint failure");
          assertEquals(
            (await sql`select count(*) as n from api_tokens`)[0].n,
            before
          );
          assertEquals(messages.length, 1);
        } finally {
          console.error = originalError;
          await sql`drop trigger if exists test_token_cleanup_failure`;
          await sql`drop trigger if exists test_token_mint_failure`;
        }
      }
    );
    await t.test(
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
        for (const [kind, table, foreignKey, id] of [
          ["food", "food_aliases", "food_id", foodId],
          [
            "exercise",
            "exercise_aliases",
            "exercise_id",
            exercise.body.exercise.id,
          ],
          ["meal", "meal_aliases", "meal_id", meal.body.meal.id],
        ] as const) {
          const alias = `batch-${uuid()}`;
          await assertRejects(() =>
            services.aliases[kind].addAliases(id, [alias, alias.toUpperCase()])
          );
          assertEquals(
            (
              await sql.unsafe(
                `SELECT id FROM ${table} WHERE ${foreignKey} = ?`,
                [id]
              )
            ).length,
            0
          );
          await services.aliases[kind].addAliases(id, []);
          await services.aliases[kind].addAliases(id, [
            alias,
            `${alias}-second`,
          ]);
          assertEquals(
            (
              await sql.unsafe(
                `SELECT id FROM ${table} WHERE ${foreignKey} = ?`,
                [id]
              )
            ).length,
            2
          );
        }
      }
    );
    await t.test(
      "exercise children roll back with creation and reclassification",
      async () => {
        await resetTraining();
        const muscle = `Bulk muscle ${uuid()}`;
        assertEquals(
          (await api.post("/muscles", { name: muscle })).status,
          201
        );
        const name = `Bulk exercise ${uuid()}`;
        const aliases = [`bulk-${uuid()}`, `bulk-${uuid()}`];
        const muscles = [
          { muscle, volume_factor: 1 },
          {
            muscle: muscle.toUpperCase(),
            volume_factor: 0.5,
          },
        ];
        const failed = await api.post("/exercises", {
          name,
          aliases,
          measure: "reps",
          muscles,
        });
        assertEquals(failed.status, 409);
        assertEquals(
          (await sql`select id from exercises where name = ${name}`).length,
          0
        );
        assertEquals(
          (
            await sql`select id from exercise_aliases where alias in (select value from json_each(${JSON.stringify(aliases)}))`
          ).length,
          0
        );
        const unknown = await api.post("/exercises", {
          name,
          aliases,
          measure: "reps",
          muscles: [
            muscles[0],
            {
              muscle: "missing bulk muscle",
              volume_factor: 1,
            },
          ],
        });
        assertEquals(unknown.status, 422);
        assert(
          unknown.body.error.includes('Unknown muscle "missing bulk muscle"')
        );
        assertEquals(
          (await sql`select id from exercises where name = ${name}`).length,
          0
        );
        const created = await api.post("/exercises", {
          name,
          aliases,
          measure: "reps",
          muscles: [muscles[0]],
        });
        assertEquals(created.status, 201);
        assertEquals(created.body.exercise.aliases.length, 2);
        const { id } = created.body.exercise;
        const replacement = await api.put(`/exercises/${id}/muscles`, {
          muscles,
        });
        assertEquals(replacement.status, 409);
        assertEquals(await exerciseById(id), created.body.exercise);
        assertEquals((await api.delete(`/exercises/${id}`)).status, 200);
        assertEquals(
          (await sql`select id from exercise_aliases where exercise_id = ${id}`)
            .length,
          0
        );
        assertEquals(
          (await sql`select id from exercise_muscles where exercise_id = ${id}`)
            .length,
          0
        );
        assertEquals(
          (await sql`select id from muscles where name = ${muscle}`).length,
          1
        );
      }
    );
    await t.test(
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
          0
        );
        const recipeFood = await food("Recipe protected food", [
          "recipe protected alias",
        ]);
        const loggedFood = await food("Intake protected food", [
          "intake protected alias",
        ]);
        assertEquals(
          (
            await api.post("/meals", {
              name: "Protected recipe",
              items: [{ food: recipeFood, grams: 50 }],
            })
          ).status,
          201
        );
        assertEquals(
          (
            await api.post("/intake", {
              day: today(),
              food: loggedFood,
              grams: 100,
            })
          ).status,
          201
        );
        const items = [...(await sql`select * from meal_items order by id`)];
        const intake = [
          ...(await sql`select * from intake_entries order by id`),
        ];
        for (const id of [recipeFood, loggedFood]) {
          const error = await assertRejects(async () => {
            await sql`delete from foods where id = ${id}`;
          });
          assert(String(error).includes("FOREIGN KEY constraint failed"));
          assertEquals(
            (await sql`select id from foods where id = ${id}`).length,
            1
          );
          assertEquals(
            (await sql`select id from food_aliases where food_id = ${id}`)
              .length,
            1
          );
        }
        assertEquals(
          [...(await sql`select * from meal_items order by id`)],
          items
        );
        assertEquals(
          [...(await sql`select * from intake_entries order by id`)],
          intake
        );
      }
    );
    await t.test(
      "exercise history still blocks the parent DELETE and keeps auxiliaries",
      async () => {
        await resetTraining();
        const muscle = `History muscle ${uuid()}`;
        assertEquals(
          (await api.post("/muscles", { name: muscle })).status,
          201
        );
        const created = await api.post("/exercises", {
          name: `History exercise ${uuid()}`,
          measure: "reps",
          aliases: [`history-${uuid()}`],
          muscles: [{ muscle, volume_factor: 1 }],
        });
        assertEquals(created.status, 201);
        const { id } = created.body.exercise;
        assertEquals(
          (
            await api.post("/sessions", {
              date: today(),
              rationale: "Keep history",
              sets: [{ exercise: id, reps: 8, effort: "hard" }],
            })
          ).status,
          201
        );
        const sets = [
          ...(await sql`select * from sets where exercise_id = ${id}`),
        ];
        const refused = await api.delete(`/exercises/${id}`);
        assertEquals(refused.status, 409);
        assert(refused.body.error.includes("1 logged set"));
        const error = await assertRejects(async () => {
          await sql`delete from exercises where id = ${id}`;
        });
        assert(String(error).includes("FOREIGN KEY constraint failed"));
        assertEquals(
          [...(await sql`select * from sets where exercise_id = ${id}`)],
          sets
        );
        assertEquals(await exerciseById(id), created.body.exercise);
        for (const table of [
          "sets",
          "mesocycle_exercises",
          "mesocycle_exercise_doses",
          "meal_items",
          "intake_entries",
        ]) {
          const restrictions = await sql.unsafe(
            `PRAGMA foreign_key_list(${table})`
          );
          const parent =
            table.includes("food") ||
            table === "meal_items" ||
            table === "intake_entries"
              ? "foods"
              : "exercises";
          const reference = restrictions.find(
            (row: { table: string }) => row.table === parent
          );
          assert(reference, `${table} retains its parent constraint`);
          assert(["NO ACTION", "RESTRICT"].includes(reference.on_delete));
        }
      }
    );
  } finally {
    await sql.end();
  }
});
