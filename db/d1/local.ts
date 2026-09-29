import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { z } from "@hono/zod-openapi";
import type { Miniflare } from "miniflare";
import { getPlatformProxy } from "wrangler";

export type LocalDatabase = Awaited<ReturnType<Miniflare["getD1Database"]>>;
const testConfig = z.object({
  d1_databases: z.array(
    z.object({
      database_id: z.string(),
      remote: z.boolean(),
      binding: z.string(),
    })
  ),
});

// Ask SQLite itself for statement boundaries, including trigger bodies and
// quoted semicolons. This is only a test loader; production uses Wrangler's
// migration command. Every statement is subsequently executed on local D1.
export function migrationStatements(source: string): string[] {
  const local = new DatabaseSync(":memory:");
  const result = [];
  try {
    local.exec("PRAGMA foreign_keys = ON");
    let remaining = source;
    while (true) {
      remaining = remaining.replace(
        /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u,
        ""
      );
      if (!remaining) {
        break;
      }
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
    new URL("wrangler.test.json", import.meta.url)
  );
  const config = testConfig.parse(
    JSON.parse(await readFile(configPath, "utf-8"))
  );
  assert.equal(config.d1_databases.length, 1);
  assert.equal(
    config.d1_databases[0].database_id,
    "00000000-0000-0000-0000-000000000000"
  );
  assert.equal(config.d1_databases[0].remote, false);
  assert.equal(config.d1_databases[0].binding, "DB");
  const platform = await getPlatformProxy<{ DB: LocalDatabase }>({
    configPath,
    persist: false,
    remoteBindings: false,
  });
  try {
    const schema = await readFile(
      new URL("migrations/0001_record.sql", import.meta.url),
      "utf-8"
    );
    await platform.env.DB.batch(
      migrationStatements(schema).map((statement) =>
        platform.env.DB.prepare(statement)
      )
    );
    return { db: platform.env.DB, dispose: () => platform.dispose() };
  } catch (error) {
    await platform.dispose();
    throw error;
  }
}
