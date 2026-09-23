import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  convertRow,
  identifier,
  safeInteger,
  sqlLiteral,
  validateColumns,
} from "./codec.mjs";
import { digest } from "./export.mjs";

export function importPlan(envelope, storage, schema) {
  const snapshot = envelope?.snapshot;
  if (
    snapshot?.format !== "personal-trainer-postgres-snapshot-v1" ||
    envelope.sha256 !== digest(snapshot)
  ) {
    throw new Error("Snapshot format or checksum is invalid.");
  }
  const names = Object.keys(storage.tables).sort();
  if (
    JSON.stringify(Object.keys(snapshot.tables).sort()) !==
      JSON.stringify(names)
  ) {
    throw new Error("Snapshot table inventory differs from the target schema.");
  }
  const local = new DatabaseSync(":memory:");
  try {
    local.exec(schema);
    const visited = new Set();
    const visiting = new Set();
    const order = [];
    const visit = (table) => {
      if (visited.has(table)) return;
      if (visiting.has(table)) {
        throw new Error("Cyclic foreign keys need a reviewed import strategy.");
      }
      visiting.add(table);
      for (
        const foreign of local.prepare(
          `PRAGMA foreign_key_list(${identifier(table)})`,
        ).all()
      ) {
        if (!storage.tables[foreign.table]) {
          throw new Error("Unknown foreign-key target.");
        }
        visit(foreign.table);
      }
      visiting.delete(table);
      visited.add(table);
      order.push(table);
    };
    names.forEach(visit);
    const counts = {};
    const statements = [];
    // The generated file never drops records or upserts over existing facts.
    statements.push(
      "CREATE TABLE d1_import_guard (empty_target INTEGER NOT NULL CHECK (empty_target = 1)) STRICT",
    );
    statements.push(
      `INSERT INTO d1_import_guard SELECT ${
        names.map((name) => `NOT EXISTS (SELECT 1 FROM ${identifier(name)})`)
          .join(" AND ")
      }`,
    );
    local.exec("PRAGMA foreign_keys = ON; BEGIN");
    for (const table of order) {
      const { columns, rows, sequence } = snapshot.tables[table];
      const spec = storage.tables[table];
      const physical = local.prepare(`PRAGMA table_info(${identifier(table)})`)
        .all();
      const extras = [
        ...Object.keys(spec.caseKeys ?? {}),
        ...(table === "bodyweight" ? ["measured_date"] : []),
      ];
      const storedColumns = physical.map((column) => column.name).filter((
        name,
      ) => !extras.includes(name)).sort();
      if (
        JSON.stringify(Object.keys(columns).sort()) !==
          JSON.stringify(storedColumns)
      ) {
        throw new Error(
          `${table}: source columns differ from the target schema.`,
        );
      }
      validateColumns(table, columns, spec);
      for (const source of rows) {
        const row = convertRow(table, source, columns, spec);
        if (spec.identity && row[spec.identity] <= 0) {
          throw new Error(
            `${table}: nonpositive identities require review before import.`,
          );
        }
        const keys = Object.keys(row);
        const prefix = `INSERT INTO ${identifier(table)} (${
          keys.map(identifier).join(", ")
        }) VALUES`;
        local.prepare(`${prefix} (${keys.map(() => "?").join(", ")})`).run(
          ...Object.values(row),
        );
        const statement = `${prefix} (${
          Object.values(row).map(sqlLiteral).join(", ")
        })`;
        if (Buffer.byteLength(statement, "utf8") > 100_000) {
          throw new Error(
            `${table}: a row exceeds the bounded D1 import statement size.`,
          );
        }
        statements.push(statement);
      }
      counts[table] = rows.length;
      if (spec.identity) {
        if (!sequence || typeof sequence.is_called !== "boolean") {
          throw new Error(`${table}: identity state is missing.`);
        }
        if (
          sequence.increment_by !== "1" || sequence.cycle !== false ||
          sequence.min_value !== "1" ||
          sequence.max_value !== "9223372036854775807"
        ) {
          throw new Error(
            `${table}: nonstandard identity allocation requires review before import.`,
          );
        }
        const last = safeInteger(sequence.last_value);
        if (last < 1) {
          throw new Error(`${table}: identity state is out of range.`);
        }
        const high = sequence.is_called ? last : last - 1;
        const max = local.prepare(
          `SELECT COALESCE(MAX(${identifier(spec.identity)}), 0) AS id FROM ${
            identifier(table)
          }`,
        ).get().id;
        if (high < max) {
          throw new Error(
            `${table}: the source sequence is behind its stored IDs. Reconcile it before migration.`,
          );
        }
        const name = sqlLiteral(table);
        const ensure =
          `INSERT INTO sqlite_sequence (name, seq) SELECT ${name}, 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ${name})`;
        const update =
          `UPDATE sqlite_sequence SET seq = ${high} WHERE name = ${name}`;
        local.exec(`${ensure}; ${update}`);
        statements.push(ensure, update);
      } else if (sequence !== null) {
        throw new Error(`${table}: unexpected identity state.`);
      }
    }
    if (local.prepare("PRAGMA foreign_key_check").all().length) {
      throw new Error("Imported rows fail foreign-key validation.");
    }
    local.exec("COMMIT");
    // Deliberately keep the guard table: a second import must fail even if every
    // source table was empty. A partial import also requires a NEW destination.
    statements.push(
      "CREATE TABLE d1_import_receipt (snapshot_sha256 TEXT PRIMARY KEY, row_counts TEXT NOT NULL CHECK (json_valid(row_counts))) STRICT",
    );
    statements.push(
      `INSERT INTO d1_import_receipt VALUES (${sqlLiteral(envelope.sha256)}, ${
        sqlLiteral(JSON.stringify(counts))
      })`,
    );
    return { statements, counts, sha256: envelope.sha256 };
  } finally {
    local.close();
  }
}

if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || process.argv.length !== 4) {
    console.error(
      "Usage: node convert.mjs INPUT.snapshot.json OUTPUT.import.sql",
    );
    process.exitCode = 1;
  } else {
    try {
      const envelope = JSON.parse(await readFile(input, "utf8"));
      const storage = JSON.parse(
        await readFile(new URL("./storage.json", import.meta.url), "utf8"),
      );
      const schema = await readFile(
        new URL("./migrations/0001_record.sql", import.meta.url),
        "utf8",
      );
      const plan = importPlan(envelope, storage, schema);
      const heading =
        "-- Private import: apply only to a NEW database with 0001_record.sql already applied.\n-- Wrangler may commit import chunks. On any failure discard the destination; do not rerun or switch traffic.\n";
      await writeFile(
        output,
        heading + plan.statements.map((sql) => sql + ";").join("\n") + "\n",
        { flag: "wx", mode: 0o600 },
      );
      console.log(
        `Validated ${
          Object.values(plan.counts).reduce((sum, n) => sum + n, 0)
        } rows across ${
          Object.keys(plan.counts).length
        } tables. The SQL file contains private records and credentials.`,
      );
    } catch {
      console.error(
        "Conversion failed. No destination was contacted. Check snapshot integrity, source schema, numeric bounds, keys, identities and output-file ownership.",
      );
      process.exitCode = 1;
    }
  }
}
