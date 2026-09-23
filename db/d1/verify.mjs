import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { convertRow, identifier } from "./codec.mjs";
import { importPlan } from "./convert.mjs";

const canonical = (rows) =>
  rows.map((row) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
  ).sort();
const hash = (rows) =>
  createHash("sha256").update(JSON.stringify(canonical(rows))).digest("hex");

// Never include rows in errors: access tokens and health records are private.
export function compareRows(name, actual, expected) {
  if (
    JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))
  ) {
    throw new Error(`${name}: independent readback differs from the source.`);
  }
  return { rows: actual.length, sha256: hash(actual) };
}

export async function verifyTransfer(envelope, query, options = {}) {
  const storage = JSON.parse(
    await readFile(new URL("./storage.json", import.meta.url), "utf8"),
  );
  const directory = new URL("./migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) =>
    name.endsWith(".sql")
  ).sort();
  const baseline = await readFile(new URL(migrations[0], directory), "utf8");
  const plan = importPlan(envelope, storage, baseline);
  const local = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations) {
      local.exec(await readFile(new URL(migration, directory), "utf8"));
    }
    local.exec("PRAGMA foreign_keys = ON;");
    for (const statement of plan.statements) local.exec(statement);
    const tables = {};
    for (const [table, source] of Object.entries(envelope.snapshot.tables)) {
      const spec = storage.tables[table];
      const expected = source.rows.map((row) =>
        convertRow(table, row, source.columns, spec)
      );
      const columns = [
        ...Object.keys(source.columns),
        ...Object.keys(spec.caseKeys ?? {}),
        ...(table === "bodyweight" ? ["measured_date"] : []),
      ];
      const actual = await query(
        `SELECT ${columns.map(identifier).join(", ")} FROM ${
          identifier(table)
        }`,
      );
      tables[table] = compareRows(table, actual, expected);
      if (spec.identity) {
        const high = Number(source.sequence.last_value) -
          (source.sequence.is_called ? 0 : 1);
        if (!Number.isSafeInteger(high + 1)) {
          throw new Error(`${table}: the next identity is not a safe integer.`);
        }
        compareRows(
          `${table} identity`,
          await query(
            `SELECT seq FROM sqlite_sequence WHERE name = '${table}'`,
          ),
          [{ seq: high }],
        );
      }
    }
    // Cloudflare owns these exact metadata tables. Local D1 additionally creates
    // _cf_METADATA; it is not an application fact or an application schema change.
    const schemaQuery = `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE tbl_name NOT IN ('_cf_KV', '_cf_METADATA', 'd1_migrations', 'sqlite_sequence')
      ORDER BY type, name`;
    compareRows(
      "complete schema",
      await query(schemaQuery),
      local.prepare(schemaQuery).all(),
    );
    compareRows(
      "session coordination versions",
      await query("SELECT id, write_version FROM sessions"),
      local.prepare("SELECT id, write_version FROM sessions").all(),
    );
    compareRows("foreign keys", await query("PRAGMA foreign_key_check"), []);
    compareRows("integrity", await query("PRAGMA quick_check"), [{
      quick_check: "ok",
    }]);
    compareRows(
      "write assertions",
      await query("SELECT * FROM api_write_assertions"),
      [],
    );
    compareRows(
      "nutrition write assertions",
      await query("SELECT * FROM nutrition_write_assertions"),
      [],
    );
    compareRows("import guard", await query("SELECT * FROM d1_import_guard"), [{
      empty_target: 1,
    }]);
    compareRows(
      "import receipt",
      await query("SELECT * FROM d1_import_receipt"),
      [{
        snapshot_sha256: envelope.sha256,
        row_counts: JSON.stringify(plan.counts),
      }],
    );
    if (options.checkMigrations !== false) {
      compareRows(
        "migration history",
        await query("SELECT name FROM d1_migrations"),
        migrations.map((name) => ({ name })),
      );
    }
    const definitions = local.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name",
    ).all();
    compareRows(
      "view definitions",
      await query(
        "SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name",
      ),
      definitions,
    );
    if (
      definitions.length !== 7 || !envelope.snapshot.views ||
      !/^\d{4}-\d{2}-\d{2}$/.test(
        envelope.snapshot.completed_weeks_before ?? "",
      )
    ) {
      throw new Error(
        "Verification requires seven source views and the source Rome week cutoff from a fresh export.",
      );
    }
    compareRows(
      "source view inventory",
      Object.keys(envelope.snapshot.views).map((name) => ({ name })),
      definitions.map(({ name }) => ({ name })),
    );
    const views = {};
    for (const { name, sql } of definitions) {
      const expected = local.prepare(`SELECT * FROM ${identifier(name)}`).all();
      views[name] = compareRows(
        name,
        await query(`SELECT * FROM ${identifier(name)}`),
        expected,
      );
      // PostgreSQL excludes unfinished weeks. Compare that separate contract
      // without dropping current/future rows from the full hosted-view check.
      let sourceQuery = `SELECT * FROM ${identifier(name)}`;
      if (["weekly_volume", "weekly_exercise_sets_done"].includes(name)) {
        sourceQuery = sql.replace(/^create\s+view\s+\w+\s+as\s+/i, "")
          .replace(
            /where t\.kind =/i,
            `where s.date < '${envelope.snapshot.completed_weeks_before}' and t.kind =`,
          );
      }
      compareRows(
        `${name} PostgreSQL parity`,
        local.prepare(sourceQuery).all(),
        envelope.snapshot.views[name],
      );
    }
    return {
      format: "personal-trainer-transfer-verification-v1",
      verified_at: new Date().toISOString(),
      snapshot_sha256: envelope.sha256,
      tables,
      views,
      identities: true,
      schema: true,
      coordination: true,
      foreign_keys: true,
      integrity: true,
      migrations: options.checkMigrations !== false,
    };
  } finally {
    local.close();
  }
}

// Run only explicitly, against the database ID printed in the operator command.
// Wrangler owns authentication. Raw JSON, rows and subprocess errors stay private.
if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [snapshotPath, databaseId, reportPath] = process.argv.slice(2);
  if (
    !snapshotPath || !/^[0-9a-f-]{36}$/.test(databaseId ?? "") || !reportPath ||
    process.argv.length !== 5
  ) {
    console.error(
      "Usage: node db/d1/verify.mjs SNAPSHOT DATABASE_UUID NEW_REPORT.json",
    );
    process.exitCode = 1;
  } else {
    try {
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const query = (sql) => {
        const output = execFileSync(process.execPath, [
          resolve(root, "node_modules/wrangler/bin/wrangler.js"),
          "d1",
          "execute",
          databaseId,
          "--remote",
          "--json",
          "--command",
          sql,
        ], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        });
        const results = JSON.parse(output);
        if (
          results.length !== 1 || results[0].success !== true ||
          !Array.isArray(results[0].results)
        ) throw new Error("Unsuccessful hosted readback.");
        return results[0].results;
      };
      const envelope = JSON.parse(await readFile(snapshotPath, "utf8"));
      const report = await verifyTransfer(envelope, query);
      await writeFile(
        reportPath,
        JSON.stringify({ database_id: databaseId, ...report }, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      console.log(
        `Verified every value in ${
          Object.keys(report.tables).length
        } tables and seven views; identities, foreign keys, integrity and migrations pass.`,
      );
    } catch {
      console.error(
        "Transfer verification failed. Do not switch traffic. Inspect privately; no records were changed by verification.",
      );
      process.exitCode = 1;
    }
  }
}
