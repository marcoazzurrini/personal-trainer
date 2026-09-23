import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { disposablePostgres } from "./postgres-fixture.mjs";
import { localDatabase, migrationStatements } from "./local.mjs";
import { digest, exportSnapshot } from "./export.mjs";
import { importPlan } from "./convert.mjs";
import { convertRow, identifier } from "./codec.mjs";
import { verifyTransfer } from "./verify.mjs";

let source;
let destination;
let envelope;
let plan;
let storage;
let schema;

before(async () => {
  source = await disposablePostgres();
  destination = await localDatabase();
  storage = JSON.parse(
    await readFile(new URL("./storage.json", import.meta.url), "utf8"),
  );
  schema = await readFile(
    new URL("./migrations/0001_record.sql", import.meta.url),
    "utf8",
  );
  await source.sql.unsafe(`
    INSERT INTO users (name, height_cm) VALUES ('Synthetic athlete', 180.1);
    SELECT setval('public.users_id_seq', 500, false);
    INSERT INTO user_context (topic, content) VALUES ('fixture', 'Synthetic text with a quote '' and Caffè');
    INSERT INTO bodyweight (value_kg, measured_at, source) VALUES
      (82.345, '2020-07-01T22:30:00.123456Z', 'manual'),
      (84, '2020-07-01T22:30:00.123456Z', 'withings');
    INSERT INTO bodyfat_estimates (day, percent, method) VALUES ('2020-01-06', 15.55, 'bia');
    INSERT INTO exercises (name) VALUES ('CAFFÈ squat');
    INSERT INTO exercise_aliases (exercise_id, alias) SELECT id, 'Synthetic squat' FROM exercises WHERE name = 'CAFFÈ squat';
    INSERT INTO exercise_muscles (exercise_id, muscle_id, volume_factor)
      SELECT e.id, m.id, 0.5 FROM exercises e, muscles m WHERE e.name = 'CAFFÈ squat' AND m.name = 'adductors';
    INSERT INTO blocks (name, goal, started_on) VALUES ('Synthetic block', 'Test history', '2020-01-06');
    INSERT INTO mesocycles (block_id, name, intent, planned_weeks, sessions_per_week, started_on, track)
      SELECT id, 'Synthetic plan', 'Keep historical facts', 6, 3, '2020-01-06', 'hypertrophy' FROM blocks WHERE name = 'Synthetic block';
    INSERT INTO mesocycle_exercises (mesocycle_id, exercise_id, role, priority)
      SELECT m.id, e.id, 'main', 1 FROM mesocycles m, exercises e WHERE m.name = 'Synthetic plan' AND e.name = 'CAFFÈ squat';
    INSERT INTO mesocycle_exercise_doses (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from)
      SELECT m.id, e.id, 10.55, 'sets', '2020-01-06' FROM mesocycles m, exercises e WHERE m.name = 'Synthetic plan' AND e.name = 'CAFFÈ squat';
    INSERT INTO mesocycle_decisions (mesocycle_id, what_changed, why, prior_intent)
      SELECT id, 'Membership removed', 'Synthetic historical coverage', 'Keep historical facts' FROM mesocycles WHERE name = 'Synthetic plan';
    DELETE FROM mesocycle_exercises;
    INSERT INTO sessions (date, rationale, started_at) VALUES ('2020-01-06', 'Synthetic workout', '2020-01-06T10:00:00.123456Z');
    INSERT INTO sets (session_id, exercise_id, mesocycle_id, position, kind, weight_kg, reps, effort, performed_at)
      SELECT s.id, e.id, m.id, 1, 'working', 100.005, 5, 'hard', '2020-01-06T10:00:00.123456Z'
      FROM sessions s, exercises e, mesocycles m WHERE e.name = 'CAFFÈ squat' AND m.name = 'Synthetic plan';
    INSERT INTO foods (name, kcal_100g, protein_100g, carbs_100g, fat_100g, fiber_100g, source)
      VALUES ('CAFFÈ food', 123.45, 12.35, 20.25, 3.55, NULL, 'label'), ('Second food', 200, 10, 20, 5, 2, 'estimate');
    UPDATE foods SET macro_revision = 2 WHERE name = 'Second food';
    INSERT INTO food_aliases (food_id, alias) SELECT id, 'Synthetic food' FROM foods WHERE name = 'CAFFÈ food';
    INSERT INTO meals (name) VALUES ('Synthetic meal');
    INSERT INTO meal_aliases (meal_id, alias) SELECT id, 'Synthetic breakfast' FROM meals WHERE name = 'Synthetic meal';
    INSERT INTO meal_items (meal_id, food_id, grams) SELECT m.id, f.id, 150.25 FROM meals m, foods f;
    INSERT INTO intake_entries (day, food_id, grams, meal_id, request_id)
      SELECT '2020-01-06', f.id, 50.3, m.id, '00000000-0000-0000-0000-000000000001' FROM foods f, meals m;
    INSERT INTO intake_entries (day, food_id, grams, kcal, protein_g, carbs_g, fat_g, food_macro_revision)
      SELECT '2020-01-06', id, 20, 999, 90, 0, 0, 1 FROM foods WHERE name = 'Second food';
    INSERT INTO intake_entries (day, food_id, grams, kcal, protein_g, carbs_g, fat_g, food_macro_revision)
      SELECT '2020-01-06', id, 20, 123.4, 12.3, 0, 0, 1 FROM foods WHERE name = 'CAFFÈ food';
    INSERT INTO intake_entries (day, kcal, protein_g) VALUES ('2020-01-07', 0.1, 0.1), ('2020-01-07', 0.2, 0.2);
    INSERT INTO day_flags (day, flag) VALUES ('2020-01-08', 'incomplete');
    INSERT INTO nutrition_targets (effective_from, goal, rate_pct_bw_week, kcal_target, protein_g_target, decision, clipped, clipped_reasons)
      VALUES ('2020-01-06', 'cut', -0.5, 2200, 160, 'Synthetic target', true, ARRAY['rate','deficit']);
    INSERT INTO nutrition_targets (effective_from, goal, rate_pct_bw_week, kcal_target, protein_g_target, decision)
      VALUES ('2020-01-13', 'gain', 0.25, 2600, 160, 'Superseded target');
    INSERT INTO nutrition_targets (effective_from, goal, rate_pct_bw_week, kcal_target, protein_g_target, decision, phase_switch_suppressed)
      VALUES ('2020-01-13', 'maintain', 0, 2400, 160, 'Same-day winner', true);
    INSERT INTO nutrition_targets (effective_from, goal, rate_pct_bw_week, kcal_target, protein_g_target, decision)
      VALUES ('2020-01-20', 'cut', -0.5, 2200, 160, 'Later target');
    INSERT INTO nutrition_events (day, kind, note) VALUES ('2020-01-06', 'creatine_start', 'Synthetic event');
    INSERT INTO week_schedules (week_start, schedule) VALUES ('2020-01-06', 'Synthetic schedule');
    INSERT INTO withings_auth (withings_user_id, access_token, refresh_token, access_token_expires_at)
      VALUES ('synthetic-account', 'not-a-real-token', 'not-a-real-refresh-token', '2020-01-07T00:00:00.123456Z');
    INSERT INTO api_tokens (token_hash, subject, issued_at, expires_at)
      VALUES ('not-a-real-hash', 'synthetic-subject', '2020-01-06T00:00:00.123456Z', '2020-01-07T00:00:00.123456Z');
  `);
  envelope = await exportSnapshot(source.url);
  plan = importPlan(envelope, storage, schema);
  await destination.db.batch(
    plan.statements.map((sql) => destination.db.prepare(sql)),
  );
});

after(async () => {
  try {
    await destination?.dispose();
  } finally {
    await source?.dispose();
  }
});

function sorted(rows) {
  return rows.map((row) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
  ).sort();
}

async function assertImportedFacts(db) {
  for (
    const [table, { rows, columns }] of Object.entries(envelope.snapshot.tables)
  ) {
    const expected = rows.map((row) =>
      convertRow(table, row, columns, storage.tables[table])
    );
    // Coordination metadata such as write_version is not a PostgreSQL fact.
    // Compare every exported and derived storage field, not runtime bookkeeping.
    const projection = expected.length
      ? Object.keys(expected[0]).map(identifier).join(", ")
      : "*";
    const actual =
      (await db.prepare(`SELECT ${projection} FROM ${identifier(table)}`).all())
        .results;
    assert.deepEqual(sorted(actual), sorted(expected), table);
  }
}

test("every exported fact survives import, including empty membership and all 27 tables", async () => {
  assert.equal(Object.keys(plan.counts).length, 27);
  await assertImportedFacts(destination.db);
  assert.equal(plan.counts.mesocycle_exercises, 0);
  assert.equal(plan.counts.mesocycle_exercise_doses, 1);
  assert.equal(
    (await destination.db.prepare("PRAGMA foreign_key_check").all()).results
      .length,
    0,
  );
});

test("the same import preserves all facts after every current coordination migration", async () => {
  const current = await localDatabase();
  try {
    const directory = new URL("./migrations/", import.meta.url);
    const files = (await readdir(directory)).filter((name) =>
      name.endsWith(".sql") && name !== "0001_record.sql"
    ).sort();
    const next = (await Promise.all(files.map((name) =>
      readFile(new URL(name, directory), "utf8")
    ))).join("\n");
    const additions = migrationStatements(schema + "\n" + next).slice(
      migrationStatements(schema).length,
    );
    await current.db.batch(additions.map((sql) =>
      current.db.prepare(sql)
    ));
    await current.db.batch(
      plan.statements.map((sql) => current.db.prepare(sql)),
    );
    await assertImportedFacts(current.db);
    const reads = new Map();
    const report = await verifyTransfer(envelope, async (sql) => {
      const rows = (await current.db.prepare(sql).all()).results;
      reads.set(sql, rows);
      return rows;
    }, { checkMigrations: false });
    assert.equal(Object.keys(report.tables).length, 27);
    assert.equal(Object.keys(report.views).length, 7);
    assert.equal(report.schema, true);
    await current.db.prepare(
      "CREATE TABLE unrecognized_facts (note TEXT NOT NULL)",
    ).run();
    try {
      await assert.rejects(
        verifyTransfer(envelope, async (sql) =>
          (await current.db.prepare(sql).all()).results, {
          checkMigrations: false,
        }),
        /complete schema: independent readback differs/,
      );
    } finally {
      await current.db.prepare("DROP TABLE unrecognized_facts").run();
    }
    for (
      const target of [
        "users",
        "sqlite_sequence",
        "daily_intake",
        "d1_import_receipt",
        "sqlite_master",
        "nutrition_write_assertions",
        "sessions",
      ]
    ) {
      await assert.rejects(
        verifyTransfer(envelope, (sql) => {
          const rows = structuredClone(reads.get(sql));
          if (
            sql.includes(`FROM ${target}`) || sql.includes(`FROM \"${target}\"`)
          ) {
            rows.push({ corrupted: true });
          }
          return rows;
        }, { checkMigrations: false }),
        /independent readback differs/,
      );
    }
    await assert.rejects(
      verifyTransfer(envelope, (sql) => {
        const rows = structuredClone(reads.get(sql));
        if (sql === "SELECT id, write_version FROM sessions") {
          rows[0].write_version += 1;
        }
        return rows;
      }, { checkMigrations: false }),
      /session coordination versions: independent readback differs/,
    );
    const exhausted = structuredClone(envelope);
    exhausted.snapshot.tables.users.sequence.last_value = String(
      Number.MAX_SAFE_INTEGER,
    );
    exhausted.snapshot.tables.users.sequence.is_called = true;
    exhausted.sha256 = digest(exhausted.snapshot);
    await assert.rejects(
      verifyTransfer(exhausted, (sql) =>
        structuredClone(reads.get(sql)), {
        checkMigrations: false,
      }),
      /users: the next identity is not a safe integer/,
    );
    assert.equal(
      (await current.db.prepare("SELECT write_version FROM sessions").first())
        .write_version,
      1,
    );
    assert.equal(
      (await current.db.prepare(
        "SELECT count(*) AS n FROM api_write_assertions",
      ).first()).n,
      0,
    );
    assert.equal(
      (await current.db.prepare("PRAGMA foreign_key_check").all()).results
        .length,
      0,
    );
  } finally {
    await current.dispose();
  }
});

test("all seven derived views match PostgreSQL on synthetic history", async () => {
  const views = await source
    .sql`SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN (SELECT viewname FROM pg_views WHERE schemaname = 'public')
    ORDER BY table_name, ordinal_position`;
  assert.equal(new Set(views.map((row) => row.table_name)).size, 7);
  for (const view of [...new Set(views.map((row) => row.table_name))]) {
    const expressions = views.filter((column) => column.table_name === view)
      .map(({ column_name: name, data_type: type }) => {
        const column = identifier(name);
        if (type === "timestamp with time zone") {
          return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
        }
        if (type === "boolean") return `${column}::integer AS ${column}`;
        if (type === "date") return `${column}::text AS ${column}`;
        if (["numeric", "bigint"].includes(type)) {
          return `${column}::float8 AS ${column}`;
        }
        return column;
      });
    const expected = await source.sql.unsafe(
      `SELECT ${expressions.join(", ")} FROM public.${identifier(view)}`,
    );
    const actual =
      (await destination.db.prepare(`SELECT * FROM ${identifier(view)}`).all())
        .results;
    assert.deepEqual(sorted(actual), sorted(expected), view);
  }
});

test("uncalled and deleted identity high-water marks survive", async () => {
  const row = await destination.db.prepare(
    "INSERT INTO users (name) VALUES ('Next synthetic user') RETURNING id",
  ).first();
  assert.equal(row.id, 500);
  const next = await source
    .sql`INSERT INTO users (name) VALUES ('Next synthetic user') RETURNING id`;
  assert.equal(Number(next[0].id), row.id);
});

test("a second import refuses to write rather than merging records", async () => {
  const before = await destination.db.prepare("SELECT COUNT(*) AS n FROM users")
    .first();
  await assert.rejects(
    destination.db.batch(
      plan.statements.map((sql) => destination.db.prepare(sql)),
    ),
  );
  assert.deepEqual(
    await destination.db.prepare("SELECT COUNT(*) AS n FROM users").first(),
    before,
  );
});

test("checksum, schema drift, unsafe IDs and nonstandard allocation fail closed", () => {
  for (
    const mutate of [
      (copy) => {
        copy.snapshot.tables.users.rows[0].name = "altered";
      },
      (copy) => {
        copy.snapshot.tables.users.rows[0].id = "9007199254740993";
        copy.sha256 = digest(copy.snapshot);
      },
      (copy) => {
        copy.snapshot.tables.users.sequence.increment_by = "2";
        copy.sha256 = digest(copy.snapshot);
      },
      (copy) => {
        copy.snapshot.tables.users.rows[0].extra = "new fact";
        copy.sha256 = digest(copy.snapshot);
      },
    ]
  ) {
    const copy = structuredClone(envelope);
    mutate(copy);
    assert.throws(() => importPlan(copy, storage, schema));
  }
});

test("source type drift is refused even when the affected table is empty", () => {
  for (const empty of [false, true]) {
    const copy = structuredClone(envelope);
    copy.snapshot.tables.users.columns.height_cm = {
      type: "double precision",
      nullable: true,
    };
    if (empty) copy.snapshot.tables.users.rows = [];
    else copy.snapshot.tables.users.rows[0].height_cm = "180.15";
    copy.sha256 = digest(copy.snapshot);
    assert.throws(() => importPlan(copy, storage, schema), /source type/);
  }
});

test("BC timestamps and nonstandard array bounds are refused before formatting", async () => {
  const [old] = await source
    .sql`SELECT written_at::text AS written_at FROM user_context LIMIT 1`;
  await source
    .sql`UPDATE user_context SET written_at = '0001-01-01 00:00:00 BC'::timestamptz`;
  await assert.rejects(exportSnapshot(source.url), /timestamp era or range/);
  await source.sql`UPDATE user_context SET written_at = ${old.written_at}`;
  await source
    .sql`UPDATE nutrition_targets SET clipped_reasons = '[0:1]={rate,deficit}'::text[] WHERE clipped`;
  await assert.rejects(
    exportSnapshot(source.url),
    /array dimensions or bounds/,
  );
  await source
    .sql`UPDATE nutrition_targets SET clipped_reasons = ARRAY['rate','deficit'] WHERE clipped`;
});

test("read-only source credentials cannot silently export an RLS-filtered subset", async () => {
  await source.sql.unsafe(
    "CREATE ROLE d1_readonly LOGIN PASSWORD 'synthetic-readonly'; GRANT USAGE ON SCHEMA public TO d1_readonly; GRANT SELECT ON ALL TABLES IN SCHEMA public TO d1_readonly; GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO d1_readonly",
  );
  const url = new URL(source.url);
  url.username = "d1_readonly";
  url.password = "synthetic-readonly";
  await assert.rejects(exportSnapshot(url.href), /row-level security/);
});

test("an ungranted source table cannot disappear from the inventory", async () => {
  await source.sql.unsafe(`
    CREATE ROLE d1_table_reader LOGIN BYPASSRLS PASSWORD 'synthetic-table-reader';
    GRANT USAGE ON SCHEMA public TO d1_table_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO d1_table_reader;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO d1_table_reader;
    CREATE TABLE public.unreviewed_fact (fact text);
    INSERT INTO public.unreviewed_fact VALUES ('Synthetic hidden fact');
  `);
  const url = new URL(source.url);
  url.username = "d1_table_reader";
  url.password = "synthetic-table-reader";
  try {
    await assert.rejects(exportSnapshot(url.href), /table inventory/);
  } finally {
    await source.sql`DROP TABLE public.unreviewed_fact`;
  }
});

test("column-level grants cannot hide an added source fact", async () => {
  await source.sql.unsafe(`
    CREATE ROLE d1_column_reader LOGIN BYPASSRLS PASSWORD 'synthetic-column-reader';
    GRANT USAGE ON SCHEMA public TO d1_column_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO d1_column_reader;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO d1_column_reader;
    REVOKE SELECT ON public.users FROM d1_column_reader;
    GRANT SELECT (${
    Object.keys(envelope.snapshot.tables.users.columns).map(identifier).join(
      ", ",
    )
  }) ON public.users TO d1_column_reader;
    ALTER TABLE public.users ADD COLUMN extra_fact text;
    UPDATE public.users SET extra_fact = 'Synthetic unreadable fact';
  `);
  const url = new URL(source.url);
  url.username = "d1_column_reader";
  url.password = "synthetic-column-reader";
  try {
    await assert.rejects(exportSnapshot(url.href), /column.*not readable/);
  } finally {
    await source.sql`ALTER TABLE public.users DROP COLUMN extra_fact`;
  }
});
