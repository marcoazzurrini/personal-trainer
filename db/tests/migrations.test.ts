import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { z } from "@hono/zod-openapi";

import { localDatabase, migrationStatements } from "./local.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const migrations = path.join(root, "db/migrations");
const kit = path.join(root, "node_modules/drizzle-kit/bin.cjs");
const journalSchema = z.object({
  version: z.string(),
  dialect: z.literal("sqlite"),
  entries: z.array(
    z.object({
      idx: z.number().int().nonnegative(),
      version: z.string(),
      when: z.number().int().positive(),
      tag: z.string(),
      breakpoints: z.boolean(),
    })
  ),
});

async function journal(directory: string) {
  return journalSchema.parse(
    JSON.parse(
      await readFile(path.join(directory, "meta/_journal.json"), "utf-8")
    )
  );
}

async function files(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [child, content] of await files(name)) {
        result.set(`${entry.name}/${child}`, content);
      }
    } else {
      result.set(entry.name, await readFile(name, "utf-8"));
    }
  }
  return result;
}

async function generation(
  exercise: (
    directory: string,
    run: (command: string) => string
  ) => Promise<void>
) {
  const directory = await mkdtemp(path.join(tmpdir(), "trainer-drizzle-test-"));
  try {
    await cp(migrations, path.join(directory, "migrations"), {
      recursive: true,
    });
    await cp(path.join(root, "db/schema"), path.join(directory, "schema"), {
      recursive: true,
    });
    await symlink(
      path.join(root, "node_modules"),
      path.join(directory, "node_modules")
    );
    const config = path.join(directory, "drizzle.config.ts");
    await writeFile(
      config,
      'export default { dialect: "sqlite", schema: "./schema/index.ts", out: "./migrations" };\n'
    );
    // Offline generation receives no provider credentials or application env.
    // The temporary schema and output never touch the working migration history.
    const run = (command: string) =>
      execFileSync(process.execPath, [kit, command, "--config", config], {
        cwd: directory,
        encoding: "utf-8",
        timeout: 120_000,
        env: {
          PATH: process.env.PATH,
          TMPDIR: tmpdir(),
          WRANGLER_SEND_METRICS: "false",
        },
      });
    await exercise(directory, run);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// This is generation metadata, not a second applied-migration ledger. The
// baseline describes the result of the four released files at their last tag.
test("the Kit baseline anchors the existing D1 history without a replay migration", async () => {
  const metadata = await journal(migrations);
  assert.equal(metadata.entries[0]?.tag, "0004_nutrition_writes");
  assert.equal(metadata.entries[0]?.idx, 4);
  for (const entry of metadata.entries) {
    assert.ok(
      await readFile(path.join(migrations, `${entry.tag}.sql`), "utf-8")
    );
  }
  assert.equal(
    metadata.entries.some((entry) => entry.tag.includes("baseline")),
    false
  );
});

test("Kit check accepts the baseline and unchanged generation writes nothing", async () => {
  await generation(async (directory, run) => {
    const output = path.join(directory, "migrations");
    const before = await files(output);
    run("check");
    assert.match(run("generate"), /No schema changes/u);
    assert.deepEqual(await files(output), before);
  });
});

test("Kit generates only a new nullable column and D1 preserves records and schema features", async () => {
  await generation(async (directory, run) => {
    const body = path.join(directory, "schema/body.ts");
    const source = await readFile(body, "utf-8");
    const marker = 'measured_date: text("measured_date").notNull(),';
    assert.equal(source.split(marker).length, 2);
    await writeFile(
      body,
      source.replace(
        marker,
        `${marker}\n    generation_probe: text("generation_probe"),`
      )
    );
    const output = path.join(directory, "migrations");
    const before = await files(output);
    run("generate");
    run("check");
    const after = await files(output);
    for (const [name, content] of before) {
      if (name !== "meta/_journal.json") {
        assert.equal(after.get(name), content, name);
      }
    }
    const added = [...after.keys()].filter((name) => !before.has(name));
    const sqlNames = added.filter((name) => name.endsWith(".sql"));
    assert.equal(sqlNames.length, 1);
    assert.match(sqlNames[0], /^0005_[^/]+\.sql$/u);
    const sql = after.get(sqlNames[0]);
    assert.ok(sql);
    assert.match(
      sql.trim(),
      /^ALTER TABLE [`"]bodyweight[`"] ADD [`"]generation_probe[`"] text;$/u
    );
    const metadata = await journal(output);
    assert.equal(metadata.entries.at(-1)?.idx, 5);
    assert.equal(`${metadata.entries.at(-1)?.tag}.sql`, sqlNames[0]);

    const platform = await localDatabase();
    const { db } = platform;
    try {
      const released = (await readdir(migrations))
        .filter((name) => name.endsWith(".sql"))
        .toSorted();
      const history = await Promise.all(
        released.map((name) => readFile(path.join(migrations, name), "utf-8"))
      );
      const remaining = migrationStatements(history.join("\n")).slice(
        migrationStatements(history[0]).length
      );
      await db.batch(remaining.map((statement) => db.prepare(statement)));
      const catalog = () =>
        db
          .prepare(
            "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('trigger', 'view', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
          )
          .all();
      const originalCatalog = await catalog();
      await db
        .prepare(
          "INSERT INTO bodyweight(value_kg, measured_at, source, measured_date) VALUES(8235, '2026-07-01T22:30:00.123456Z', 'manual', '2026-07-02')"
        )
        .run();
      // Exercise precisely the generated additive SQL on actual disposable D1.
      await db.prepare(sql).run();
      const records = await db
        .prepare(
          "SELECT value_kg, measured_at, source, measured_date, generation_probe FROM bodyweight"
        )
        .all();
      assert.deepEqual(records.results, [
        {
          value_kg: 8235,
          measured_at: "2026-07-01T22:30:00.123456Z",
          source: "manual",
          measured_date: "2026-07-02",
          generation_probe: null,
        },
      ]);
      assert.deepEqual((await catalog()).results, originalCatalog.results);
      const strict = await db
        .prepare("PRAGMA table_list")
        .all<{ name: string; strict: number }>();
      assert.equal(
        strict.results.find((table) => table.name === "bodyweight")?.strict,
        1
      );
    } finally {
      await platform.dispose();
    }
  });
});
