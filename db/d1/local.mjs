import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { DatabaseSync } from "node:sqlite";

// Ask SQLite itself for statement boundaries, including trigger bodies and
// quoted semicolons. This is only a test loader; production uses Wrangler's
// migration command. Every statement is subsequently executed on local D1.
export function migrationStatements(source) {
  const local = new DatabaseSync(":memory:");
  const result = [];
  try {
    local.exec("PRAGMA foreign_keys = ON");
    let remaining = source;
    while (true) {
      remaining = remaining.replace(
        /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/,
        "",
      );
      if (!remaining) break;
      const statement = local.prepare(remaining);
      const text = statement.sourceSQL;
      if (!text || !remaining.startsWith(text)) {
        throw new Error("Cannot determine a migration statement boundary.");
      }
      statement.run();
      result.push(text);
      remaining = remaining.slice(text.length);
    }
    return result;
  } finally {
    local.close();
  }
}

export async function localDatabase() {
  const configPath = fileURLToPath(
    new URL("./wrangler.test.json", import.meta.url),
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.d1_databases.length, 1);
  assert.equal(
    config.d1_databases[0].database_id,
    "00000000-0000-0000-0000-000000000000",
  );
  assert.equal(config.d1_databases[0].remote, false);
  assert.equal(config.d1_databases[0].binding, "DB");
  const platform = await getPlatformProxy({
    configPath,
    persist: false,
    remoteBindings: false,
  });
  try {
    const schema = await readFile(
      new URL("./migrations/0001_record.sql", import.meta.url),
      "utf8",
    );
    await platform.env.DB.batch(
      migrationStatements(schema).map((statement) =>
        platform.env.DB.prepare(statement)
      ),
    );
    return { db: platform.env.DB, dispose: () => platform.dispose() };
  } catch (error) {
    await platform.dispose();
    throw error;
  }
}
