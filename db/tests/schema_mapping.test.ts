import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import { getTableColumns, getTableName, is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  getTableConfig,
  getViewConfig,
  SQLiteColumn,
  SQLiteSyncDialect,
  SQLiteTable,
  SQLiteView,
} from "drizzle-orm/sqlite-core";

import config from "../drizzle.config.ts";
import * as schema from "../schema/index.ts";
import { localDatabase, migrationStatements } from "./local.ts";
import type { LocalDatabase } from "./local.ts";

const migrationNames = [
  "0001_record.sql",
  "0002_session_writes.sql",
  "0003_plan_writes.sql",
  "0004_nutrition_writes.sql",
];
const tables = Object.values(schema).filter((value) => is(value, SQLiteTable));
const views = Object.values(schema).filter((value) => is(value, SQLiteView));
const dialect = new SQLiteSyncDialect();
let platform: Awaited<ReturnType<typeof localDatabase>>;
let db: LocalDatabase;

interface CatalogEntry {
  name: string;
  type: string;
  sql: string;
}
interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}
let catalog: CatalogEntry[];

before(async () => {
  platform = await localDatabase();
  ({ db } = platform);
  const migrations = await Promise.all(
    migrationNames.map((name) =>
      readFile(new URL(`../migrations/${name}`, import.meta.url), "utf-8")
    )
  );
  // localDatabase applies only 0001. Parsing the entire history lets SQLite
  // resolve ALTER TABLE targets while finding boundaries for the later files.
  const remaining = migrationStatements(migrations.join("\n")).slice(
    migrationStatements(migrations[0]).length
  );
  await db.batch(remaining.map((statement) => db.prepare(statement)));
  ({ results: catalog } = await db
    .prepare(
      "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_METADATA', 'd1_migrations')"
    )
    .all<CatalogEntry>());
});
after(async () => {
  await platform?.dispose();
});

function catalogSQL(name: string) {
  const entry = catalog.find((item) => item.name === name);
  assert.ok(entry, `Missing catalog entry: ${name}`);
  return entry.sql;
}

function render(expression: SQL) {
  const query = dialect.sqlToQuery(expression);
  assert.deepEqual(
    query.params,
    [],
    "Schema SQL must contain no bind parameters"
  );
  return query.sql;
}

// Ignore formatting and Drizzle's quoted table qualifiers, not string values.
// Keeping quoted literals intact catches changes to 'Z', JSON and enum checks.
function normalize(source: string) {
  return (
    source
      .replaceAll(/"[^"]+"\./gu, "")
      .match(/'(?:''|[^'])*'|"[^"]+"|[a-z_][a-z_0-9]*|[^\s]/giu) ?? []
  )
    .map((token) =>
      token.startsWith("'") ? token : token.replaceAll('"', "").toLowerCase()
    )
    .join(" ");
}

// Parentheses inside SQL strings do not delimit CHECK or index expressions.
function parenthesized(source: string, start: number) {
  let depth = 0;
  let quoted = false;
  for (let position = start; position < source.length; position += 1) {
    const character = source[position];
    if (character === "'") {
      if (quoted && source[position + 1] === "'") {
        position += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted) {
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          return {
            expression: source.slice(start + 1, position),
            end: position + 1,
          };
        }
      }
    }
  }
  throw new Error("Unbalanced schema SQL expression");
}

function defaultSQL(column: SQLiteColumn): string | null {
  const value = column.default;
  if (value === undefined) {
    return null;
  }
  if (is(value, SQL)) {
    const expression = render(value);
    return normalize(
      expression.startsWith("(")
        ? parenthesized(expression, 0).expression
        : expression
    );
  }
  if (typeof value === "string") {
    return normalize(`'${value.replaceAll("'", "''")}'`);
  }
  assert.equal(typeof value, "number");
  return normalize(String(value));
}

function sorted<T>(items: T[]) {
  return items.toSorted((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

async function columnsOf(name: string) {
  return (await db.prepare(`PRAGMA table_info("${name}")`).all<ColumnInfo>())
    .results;
}

test("Drizzle config stays offline with one db/schema input and one db/migrations output", () => {
  assert.equal(config.dialect, "sqlite");
  assert.equal(config.schema, "./db/schema/index.ts");
  assert.equal(config.out, "./db/migrations");
  assert.equal("dbCredentials" in config, false);
  assert.equal("driver" in config, false);
});

test("schema exports match all 29 migrated tables and all seven existing views", () => {
  assert.equal(tables.length, 29);
  assert.equal(views.length, 7);
  assert.equal(Object.keys(schema).length, tables.length + views.length);
  assert.deepEqual(
    tables.map(getTableName).toSorted(),
    catalog
      .filter((item) => item.type === "table")
      .map((item) => item.name)
      .toSorted()
  );
  assert.deepEqual(
    views.map((view) => getViewConfig(view).name).toSorted(),
    catalog
      .filter((item) => item.type === "view")
      .map((item) => item.name)
      .toSorted()
  );
  for (const [key, value] of Object.entries(schema)) {
    assert.equal(
      key,
      is(value, SQLiteTable) ? getTableName(value) : getViewConfig(value).name
    );
  }
});

test("every column matches migrated type, order, nullability, default and primary key", async () => {
  for (const table of tables) {
    const definition = getTableConfig(table);
    const actual = await columnsOf(definition.name);
    assert.deepEqual(
      Object.keys(getTableColumns(table)),
      actual.map((column) => column.name),
      definition.name
    );
    assert.deepEqual(
      definition.columns.map((column) => ({
        name: column.name,
        type: column.getSQLType().toUpperCase(),
        notNull: column.notNull,
        primary: column.primary,
        default: defaultSQL(column),
      })),
      actual.map((column) => ({
        name: column.name,
        type: column.type,
        // SQLite reports notnull=0 for INTEGER PRIMARY KEY despite rowid being
        // non-null. STRICT also makes other primary keys implicitly NOT NULL.
        notNull: Boolean(column.notnull || column.pk),
        primary: Boolean(column.pk),
        default:
          column.dflt_value === null ? null : normalize(column.dflt_value),
      })),
      definition.name
    );
    assert.deepEqual(
      definition.primaryKeys,
      [],
      "All existing primary keys are single-column"
    );
    const primary = definition.columns.find((column) => column.primary);
    assert.ok(primary);
    const autoIncrement = "autoIncrement" in primary && primary.autoIncrement;
    assert.equal(
      Boolean(autoIncrement),
      /\bAUTOINCREMENT\b/u.test(catalogSQL(definition.name)),
      definition.name
    );
  }
});

test("all CHECK expressions and existing constraint names survive the mapping", () => {
  for (const table of tables) {
    const definition = getTableConfig(table);
    const source = catalogSQL(definition.name);
    const actual = [
      ...source.matchAll(/(?:CONSTRAINT\s+(?<name>\w+)\s+)?CHECK\s*\(/giu),
    ].map((match) => ({
      name: match.groups?.name,
      expression: normalize(
        parenthesized(source, match.index + match[0].length - 1).expression
      ),
    }));
    assert.deepEqual(
      definition.checks
        .map((check) => normalize(render(check.value)))
        .toSorted(),
      actual.map((check) => check.expression).toSorted(),
      definition.name
    );
    assert.equal(
      new Set(definition.checks.map((check) => check.name)).size,
      definition.checks.length,
      `${definition.name}: duplicate check names`
    );
    for (const check of actual.filter((item) => item.name !== undefined)) {
      const declared = definition.checks.find(
        (item) => item.name === check.name
      );
      assert.ok(declared, `${definition.name}.${check.name}`);
      assert.equal(normalize(render(declared.value)), check.expression);
    }
  }
});

test("unique constraints and indexes preserve names, column order, descending keys and predicates", async () => {
  for (const table of tables) {
    const definition = getTableConfig(table);
    const source = catalogSQL(definition.name);
    const actualUniques = [
      ...source.matchAll(
        /CONSTRAINT\s+(?<name>\w+)\s+UNIQUE\s*\((?<columns>[^)]+)\)/giu
      ),
    ].map((match) => {
      assert.ok(match.groups);
      return {
        name: match.groups.name,
        columns: match.groups.columns.split(",").map((column) => column.trim()),
      };
    });
    assert.deepEqual(
      sorted(
        definition.uniqueConstraints.map((constraint) => ({
          name: constraint.name,
          columns: constraint.columns.map((column) => column.name),
        }))
      ),
      sorted(actualUniques),
      definition.name
    );
    const { results: indexes } = await db
      .prepare(`PRAGMA index_list("${definition.name}")`)
      .all<{ name: string; origin: string; unique: number }>();
    assert.deepEqual(
      definition.indexes.map((index) => index.config.name).toSorted(),
      indexes
        .filter((index) => index.origin === "c")
        .map((index) => index.name)
        .toSorted(),
      definition.name
    );
    assert.equal(
      indexes.filter((index) => index.origin === "u").length,
      actualUniques.length,
      definition.name
    );
    for (const { config: index } of definition.indexes) {
      const indexSQL = catalogSQL(index.name);
      const actual = parenthesized(indexSQL, indexSQL.indexOf("("));
      assert.equal(
        index.unique,
        Boolean(indexes.find((item) => item.name === index.name)?.unique),
        index.name
      );
      assert.equal(
        normalize(
          index.columns
            .map((column) => (is(column, SQL) ? render(column) : column.name))
            .join(", ")
        ),
        normalize(actual.expression),
        index.name
      );
      assert.equal(
        index.where ? normalize(render(index.where)) : "",
        normalize(indexSQL.slice(actual.end).replace(/^\s*where\s+/iu, "")),
        index.name
      );
    }
  }
});

test("foreign keys preserve every reference and only the three owned-registry cascades", async () => {
  let cascades = 0;
  for (const table of tables) {
    const definition = getTableConfig(table);
    const { results: actual } = await db
      .prepare(`PRAGMA foreign_key_list("${definition.name}")`)
      .all<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
        on_update: string;
      }>();
    cascades += definition.foreignKeys.filter(
      (key) => key.onDelete === "cascade"
    ).length;
    const declared = definition.foreignKeys.map((key) => {
      const reference = key.reference();
      assert.equal(reference.columns.length, 1);
      return {
        table: getTableName(reference.foreignTable),
        from: reference.columns[0].name,
        to: reference.foreignColumns[0].name,
        on_delete: (key.onDelete ?? "no action").toUpperCase(),
        on_update: (key.onUpdate ?? "no action").toUpperCase(),
      };
    });
    assert.deepEqual(
      sorted(declared),
      sorted(
        actual.map(({ table: target, from, to, on_delete, on_update }) => ({
          table: target,
          from,
          to,
          on_delete,
          on_update,
        }))
      ),
      definition.name
    );
    for (const match of catalogSQL(definition.name).matchAll(
      /CONSTRAINT\s+(?<name>\w+)\s+FOREIGN KEY/giu
    )) {
      assert.ok(match.groups);
      const { name } = match.groups;
      assert.ok(
        definition.foreignKeys.some((key) => key.getName() === name),
        name
      );
    }
  }
  assert.equal(cascades, 3);
});

test("existing views expose every migrated column in order without owning view SQL", async () => {
  const record = drizzle(db);
  for (const view of views) {
    const definition = getViewConfig(view);
    assert.equal(definition.isExisting, true, definition.name);
    assert.equal(definition.query, undefined, definition.name);
    const actual = await columnsOf(definition.name);
    assert.deepEqual(
      Object.keys(definition.selectedFields),
      actual.map((column) => column.name),
      definition.name
    );
    for (const [key, field] of Object.entries(definition.selectedFields)) {
      assert.ok(is(field, SQLiteColumn));
      assert.equal(field.name, key);
      const column = actual.find((item) => item.name === key);
      assert.ok(column);
      // SQLite reports no type (or BLOB affinity in unions) for computed
      // expressions, not their runtime value type. Populated views are tested below.
      if (column.type !== "" && column.type !== "BLOB") {
        assert.equal(
          field.getSQLType().toUpperCase(),
          column.type,
          `${definition.name}.${key}`
        );
      }
    }
    await record.select().from(view).limit(1);
  }
});

test("stored numbers, text instants, JSON and 0/1 flags have no mapping coercion", () => {
  for (const table of tables) {
    for (const column of getTableConfig(table).columns) {
      const type = column.getSQLType().toUpperCase();
      assert.ok(["INTEGER", "INT", "TEXT"].includes(type));
      const value = type === "TEXT" ? "2026-07-01T22:30:00.123456Z" : 8235;
      assert.equal(
        column.mapToDriverValue(value),
        value,
        `${getTableName(table)}.${column.name}`
      );
      assert.equal(
        column.mapFromDriverValue(value),
        value,
        `${getTableName(table)}.${column.name}`
      );
      assert.equal(column.defaultFn, undefined);
      assert.equal(column.onUpdateFn, undefined);
    }
  }
  for (const view of views) {
    for (const field of Object.values(getViewConfig(view).selectedFields)) {
      assert.ok(is(field, SQLiteColumn));
      const value =
        field.getSQLType() === "text" ? "2026-07-01T22:30:00.123456Z" : 82.35;
      assert.equal(field.mapFromDriverValue(value), value);
    }
  }
});

test("Drizzle round-trips scaled bodyweight, microseconds, JSON flags and internal versions on native D1", async () => {
  const record = drizzle(db);
  const instant = "2026-07-01T22:30:00.123456Z";
  const [weight] = await record
    .insert(schema.bodyweight)
    .values({
      value_kg: 8235,
      measured_at: instant,
      measured_date: "2026-07-02",
    })
    .returning();
  assert.equal(weight.value_kg, 8235);
  assert.equal(weight.measured_at, instant);
  assert.equal(weight.source, "manual");
  const [daily] = await record.select().from(schema.daily_bodyweight);
  assert.equal(daily.value_kg, 82.35);
  assert.equal(daily.measured_at, instant);

  const [target] = await record
    .insert(schema.nutrition_targets)
    .values({
      effective_from: "2026-07-01",
      goal: "maintain",
      rate_pct_bw_week: 0,
      kcal_target: 2400,
      protein_g_target: 160,
      decision: "Mapping test",
      clipped: 1,
      clipped_reasons: '["rate"]',
      created_at: instant,
    })
    .returning();
  assert.equal(target.clipped, 1);
  assert.equal(target.clipped_reasons, '["rate"]');
  assert.equal(target.phase_switch_suppressed, 0);
  assert.equal(target.created_at, instant);

  await record
    .insert(schema.sessions)
    .values({ date: "2026-07-01", rationale: "Mapping test" });
  await record
    .update(schema.sessions)
    .set({ notes: "The SQL trigger owns the version" });
  const [session] = await record.select().from(schema.sessions);
  assert.equal(session.write_version, 1);
  const [assertion] = await record
    .insert(schema.api_write_assertions)
    .values({ id: 1 })
    .returning();
  assert.equal(assertion.version_matches, 1);
  assert.equal(assertion.rows_match, 1);
  assert.equal(assertion.plan_matches, 1);
  await record.delete(schema.api_write_assertions);
  const [nutritionAssertion] = await record
    .insert(schema.nutrition_write_assertions)
    .values({ id: 1 })
    .returning();
  assert.equal(nutritionAssertion.valid, 1);
  await record.delete(schema.nutrition_write_assertions);
});

test("populated views retain native D1 numbers, text and nulls in every column", async () => {
  const record = drizzle(db);
  const instant = "2020-01-06T10:00:00.123456Z";
  const [block] = await record
    .insert(schema.blocks)
    .values({
      name: "Mapping block",
      goal: "Mapping",
      started_on: "2020-01-06",
    })
    .returning();
  const [mesocycle] = await record
    .insert(schema.mesocycles)
    .values({
      block_id: block.id,
      name: "Mapping mesocycle",
      intent: "Mapping",
      planned_weeks: 4,
      sessions_per_week: 3,
      started_on: "2020-01-06",
      track: "strength",
    })
    .returning();
  const [exercise] = await record
    .insert(schema.exercises)
    .values({ name: "Mapping exercise", name_key: "mapping exercise" })
    .returning();
  const [muscle] = await record
    .insert(schema.muscles)
    .values({ name: "Mapping muscle" })
    .returning();
  await record.insert(schema.exercise_muscles).values({
    exercise_id: exercise.id,
    muscle_id: muscle.id,
    volume_factor: 5,
  });
  const [session] = await record
    .insert(schema.sessions)
    .values({ date: "2020-01-06", rationale: "Mapping" })
    .returning();
  await record.insert(schema.sets).values({
    session_id: session.id,
    exercise_id: exercise.id,
    mesocycle_id: mesocycle.id,
    position: 1,
    kind: "working",
    reps: 5,
    distance_m: 123,
    duration_s: 456,
  });
  await record.insert(schema.bodyweight).values({
    value_kg: 8123,
    measured_at: instant,
    measured_date: "2020-01-06",
  });
  await record.insert(schema.intake_entries).values({
    day: "2020-01-06",
    kcal: 1234,
    protein_g: 123,
    created_at: instant,
  });
  await record
    .insert(schema.day_flags)
    .values({ day: "2020-01-07", flag: "incomplete" });
  await record.insert(schema.nutrition_targets).values([
    {
      effective_from: "2020-01-06",
      goal: "maintain",
      rate_pct_bw_week: 0,
      kcal_target: 2400,
      protein_g_target: 160,
      decision: "Mapping",
      created_at: instant,
    },
    {
      effective_from: "2020-01-07",
      goal: "gain",
      rate_pct_bw_week: 25,
      kcal_target: 2600,
      protein_g_target: 160,
      decision: "Mapping",
      created_at: instant,
    },
  ]);
  await record
    .insert(schema.nutrition_events)
    .values({ day: "2020-01-06", kind: "other", created_at: instant });
  for (const view of views) {
    const definition = getViewConfig(view);
    const native = await db
      .prepare(`SELECT * FROM "${definition.name}"`)
      .all<Record<string, string | number | null>>();
    const mapped = await record.select().from(view);
    assert.ok(native.results.length > 0, definition.name);
    assert.deepEqual(sorted(mapped), sorted(native.results), definition.name);
    for (const row of native.results) {
      for (const [key, field] of Object.entries(definition.selectedFields)) {
        assert.ok(is(field, SQLiteColumn));
        const value = row[key];
        if (value === null) {
          assert.equal(field.notNull, false, `${definition.name}.${key}`);
        } else {
          assert.equal(
            typeof value,
            field.getSQLType() === "text" ? "string" : "number",
            `${definition.name}.${key}`
          );
        }
      }
    }
  }
});
