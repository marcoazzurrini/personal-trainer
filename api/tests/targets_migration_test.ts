import { assertEquals } from "@std/assert";
import postgres from "postgres";
import { DB_URL, uuid } from "./helpers.ts";

Deno.test("goal-switch migration preserves legacy rows and derives existing effective history", async () => {
  // A private schema inside the already verified disposable database. Seed
  // the pre-migration shape so preservation is tested across the migration,
  // not merely by inserting a legacy-looking row after it.
  const db = postgres(DB_URL, { prepare: false, onnotice: () => {} });
  const schema = `test_goal_switches_${uuid().replaceAll("-", "")}`;
  const migration = await Deno.readTextFile(
    new URL(
      "../../db/migrations/20260908130000_goal_switches_come_from_targets.sql",
      import.meta.url,
    ),
  );
  try {
    await db.begin(async (tx) => {
      await tx`create schema ${tx(schema)}`;
      await tx`select set_config('search_path', ${schema}, true)`;
      await tx`create table nutrition_targets (like public.nutrition_targets including all)`;
      await tx`alter table nutrition_targets drop column phase_switch_suppressed`;
      await tx`create table nutrition_events (like public.nutrition_events including all)`;
      await tx`
        insert into nutrition_targets
          (effective_from, goal, rate_pct_bw_week, kcal_target, protein_g_target, decision)
        values ('2026-01-01', 'cut', -0.5, 2200, 180, 'Historical cut'),
          ('2026-01-02', 'maintain', 0, 2500, 180, 'Historical maintenance')`;
      await tx`
        insert into nutrition_events (day, kind, note, request_id)
        values ('2026-01-02', 'phase_switch', 'cut -> maintain', null),
          ('2026-01-02', 'phase_switch', 'cut -> maintain', ${uuid()}),
          ('2026-01-03', 'other', 'Explicit historical observation', null)`;
      const targets = [
        ...await tx`select * from nutrition_targets order by id`,
      ];
      const events = [...await tx`select * from nutrition_events order by id`];

      await tx.unsafe(migration);

      const views = await tx`
        select relname from pg_class
        where relnamespace = ${schema}::regnamespace and relkind = 'v'
          and 'security_invoker=on' = any(reloptions)
        order by relname`;
      assertEquals(views.map((view) => view.relname), [
        "nutrition_effective_events",
        "nutrition_goal_switches",
      ]);
      assertEquals(
        [...await tx`select * from nutrition_events order by id`],
        events,
      );
      const migrated = [
        ...await tx`select * from nutrition_targets order by id`,
      ];
      assertEquals(
        migrated,
        targets.map((target) => ({
          ...target,
          phase_switch_suppressed: false,
        })),
      );
      const combined = await tx`select * from nutrition_effective_events`;
      assertEquals(combined.length, 4);
      const [automatic] = await tx`select * from nutrition_goal_switches`;
      assertEquals(Number(automatic.id), -Number(targets[1].id));
      assertEquals(automatic.note, "cut -> maintain");
      await tx`drop schema ${tx(schema)} cascade`;
    });
  } finally {
    await db.end();
  }
});
