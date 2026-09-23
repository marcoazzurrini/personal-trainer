import postgres from "postgres";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { caseKey, identifier } from "./codec.mjs";

export function digest(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export async function exportSnapshot(databaseUrl) {
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error("Supply an explicit PostgreSQL source URL.");
  }
  const storage = JSON.parse(
    await readFile(new URL("./storage.json", import.meta.url), "utf8"),
  );
  const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql")).sort().map((name) =>
      name.slice(0, -4)
    );
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    onnotice() {},
  });
  try {
    const snapshot = await sql.begin(
      "isolation level repeatable read read only",
      async (tx) => {
        await tx`set local time zone 'UTC'`;
        await tx`set local datestyle = 'ISO, YMD'`;
        await tx`set local search_path = pg_catalog, public`;
        // A SELECT-only role must fail, not export an RLS-filtered subset.
        await tx`set local row_security = off`;
        // information_schema filters by caller privileges and can hide facts.
        // Inventory relations separately so even a zero-column table is visible.
        const relations = await tx`
          select c.relname as table_name
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p', 'f')
          order by c.relname`;
        const names = relations.map((row) => row.table_name)
          .filter((name) => name !== "schema_migrations").sort();
        if (
          JSON.stringify(names) !==
            JSON.stringify(Object.keys(storage.tables).sort())
        ) {
          throw new Error(
            "The source table inventory differs from the reviewed D1 schema. Stop and review schema drift.",
          );
        }
        const catalog = await tx`
          select c.relname as table_name, a.attname as column_name,
            case when t.typelem <> 0 and t.typlen = -1 then 'ARRAY'
              else pg_catalog.format_type(a.atttypid, null) end as data_type,
            case when a.attnotnull then 'NO' else 'YES' end as is_nullable,
            information_schema._pg_numeric_precision(a.atttypid, a.atttypmod) as numeric_precision,
            information_schema._pg_numeric_scale(a.atttypid, a.atttypmod) as numeric_scale,
            case when a.attidentity <> '' then 'YES' else 'NO' end as is_identity,
            pg_catalog.has_column_privilege(c.oid, a.attnum, 'SELECT') as can_select
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          join pg_catalog.pg_attribute a on a.attrelid = c.oid
          join pg_catalog.pg_type t on t.oid = a.atttypid
          where n.nspname = 'public' and c.relkind in ('r', 'p', 'f')
            and a.attnum > 0 and not a.attisdropped
          order by c.relname, a.attnum`;
        const unreadable = catalog.find((column) => !column.can_select);
        if (unreadable) {
          throw new Error(
            `${unreadable.table_name}.${unreadable.column_name}: source column is not readable. Export requires SELECT on every column.`,
          );
        }
        const applied =
          (await tx`select version from public.schema_migrations order by version`)
            .map((row) => row.version);
        if (JSON.stringify(applied) !== JSON.stringify(migrations)) {
          throw new Error(
            "The source migration history differs from this checkout. Migrate or review the source first.",
          );
        }
        const tables = {};
        for (const table of names) {
          const sourceColumns = catalog.filter((column) =>
            column.table_name === table
          );
          const identities = sourceColumns.filter((column) =>
            column.is_identity === "YES"
          ).map((column) => column.column_name);
          const expectedIdentity = storage.tables[table].identity
            ? [storage.tables[table].identity]
            : [];
          if (JSON.stringify(identities) !== JSON.stringify(expectedIdentity)) {
            throw new Error(
              `${table}: identity definition differs from the reviewed schema.`,
            );
          }
          const columns = Object.fromEntries(
            sourceColumns.map((column) => [column.column_name, {
              type: column.data_type,
              nullable: column.is_nullable === "YES",
              ...(column.data_type === "numeric"
                ? {
                  precision: column.numeric_precision,
                  scale: column.numeric_scale,
                }
                : {}),
            }]),
          );
          for (const { column_name: name, data_type: type } of sourceColumns) {
            const column = identifier(name);
            if (type === "timestamp with time zone") {
              const unsupported = await tx.unsafe(
                `SELECT 1 FROM public.${
                  identifier(table)
                } WHERE ${column} IS NOT NULL AND NOT (${column} >= '0001-01-01 00:00:00+00'::timestamptz AND ${column} < '10000-01-01 00:00:00+00'::timestamptz) LIMIT 1`,
              );
              if (unsupported.length) {
                throw new Error(
                  `${table}.${name}: timestamp era or range cannot be represented in D1.`,
                );
              }
            }
            if (type === "ARRAY") {
              const unsupported = await tx.unsafe(
                `SELECT 1 FROM public.${
                  identifier(table)
                } WHERE cardinality(${column}) > 0 AND (array_ndims(${column}) <> 1 OR array_lower(${column}, 1) <> 1) LIMIT 1`,
              );
              if (unsupported.length) {
                throw new Error(
                  `${table}.${name}: nonstandard array dimensions or bounds cannot be represented in D1.`,
                );
              }
            }
          }
          const expressions = sourceColumns.map(
            ({ column_name: name, data_type: type }) => {
              const column = identifier(name);
              if (type === "timestamp with time zone") {
                return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
              }
              if (type === "ARRAY") {
                return `array_to_json(${column})::text AS ${column}`;
              }
              return `${column}::text AS ${column}`;
            },
          );
          const rows = await tx.unsafe(
            `SELECT ${expressions.join(", ")} FROM public.${
              identifier(table)
            } ORDER BY ${
              identifier(
                storage.tables[table].identity ?? sourceColumns[0].column_name,
              )
            }`,
          );
          // PostgreSQL's locale can differ from JavaScript Unicode lowercase.
          // Refuse known differences instead of silently changing stored identity.
          for (
            const source of Object.values(storage.tables[table].caseKeys ?? {})
          ) {
            const keys = await tx.unsafe(
              `SELECT ${identifier(source)} AS value, lower(${
                identifier(source)
              }) AS key FROM public.${identifier(table)}`,
            );
            if (keys.some(({ value, key }) => caseKey(value) !== key)) {
              throw new Error(
                `${table}: Unicode case matching differs from PostgreSQL. Resolve the policy before exporting.`,
              );
            }
          }
          let sequence = null;
          if (storage.tables[table].identity) {
            const [sequenceName] = await tx`
            select n.nspname, c.relname, s.seqincrement::text AS increment_by,
              s.seqcycle AS cycle, s.seqmin::text AS min_value, s.seqmax::text AS max_value
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_sequence s on s.seqrelid = c.oid
            where c.oid = pg_get_serial_sequence(${`public.${
              identifier(table)
            }`}, ${storage.tables[table].identity})::regclass`;
            if (!sequenceName) {
              throw new Error(`${table}: identity sequence is missing.`);
            }
            const [state] = await tx.unsafe(
              `SELECT last_value::text, is_called FROM ${
                identifier(sequenceName.nspname)
              }.${identifier(sequenceName.relname)}`,
            );
            sequence = {
              ...state,
              increment_by: sequenceName.increment_by,
              cycle: sequenceName.cycle,
              min_value: sequenceName.min_value,
              max_value: sequenceName.max_value,
            };
          }
          tables[table] = { columns, rows: [...rows], sequence };
        }
        const viewColumns = await tx`
          SELECT table_name, column_name, data_type
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN (SELECT viewname FROM pg_views WHERE schemaname = 'public')
          ORDER BY table_name, ordinal_position`;
        const views = {};
        for (
          const view of new Set(viewColumns.map((column) => column.table_name))
        ) {
          const expressions = viewColumns.filter((column) =>
            column.table_name === view
          )
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
          views[view] = [
            ...await tx.unsafe(
              `SELECT ${expressions.join(", ")} FROM public.${
                identifier(view)
              }`,
            ),
          ];
        }
        const [calendar] = await tx`
          SELECT date_trunc('week', now() AT TIME ZONE 'Europe/Rome')::date::text AS week_start`;
        return {
          format: "personal-trainer-postgres-snapshot-v1",
          exported_at: new Date().toISOString(),
          migrations: applied,
          tables,
          views,
          completed_weeks_before: calendar.week_start,
        };
      },
    );
    return { sha256: digest(snapshot), snapshot };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [flag, output] = process.argv.slice(2);
  if (
    flag !== "--writes-frozen" || !output || process.argv.length !== 4 ||
    !process.env.D1_SOURCE_DATABASE_URL
  ) {
    console.error(
      "Usage: D1_SOURCE_DATABASE_URL=... node export.mjs --writes-frozen OUTPUT.snapshot.json\nUse a read-only source credential. Stop every source writer before the final export; sequences are not transactional. No .env file or default DATABASE_URL is read.",
    );
    process.exitCode = 1;
  } else {
    try {
      const exported = await exportSnapshot(process.env.D1_SOURCE_DATABASE_URL);
      await writeFile(output, JSON.stringify(exported), {
        flag: "wx",
        mode: 0o600,
      });
      console.log(
        `Exported ${
          Object.keys(exported.snapshot.tables).length
        } tables. Keep the snapshot private; it contains records and credentials.`,
      );
    } catch {
      // Connection errors can echo URLs; SQL errors can include private values.
      console.error(
        "Export failed. No source changes were made. Check source access, migration history, table inventory, Unicode keys, and output-file ownership.",
      );
      process.exitCode = 1;
    }
  }
}
