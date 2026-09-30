import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf-8");

// These files have already run in production. Extend the history with a new
// migration; do not edit or rename a migration that D1 has already recorded.
const released = {
  "0001_record.sql":
    "fe2daf89a4d5b23b36c358b4f74cf1c328bb95d80b2c439e76895531b76c3d83",
  "0002_session_writes.sql":
    "1d4f8d9e5ecc7b609ac29f9e618ef3912109df5550ec41b8f84a555bc377d988",
  "0003_plan_writes.sql":
    "23982a6d7503be3530d1f3d423bab03b7e212cb743106eb315bd62ef075f059d",
  "0004_nutrition_writes.sql":
    "bf2aede828df3d8012edf5ae87770180494b96d081684cdbf558d1e1429fd550",
};

test("released D1 migrations keep their names and exact contents", async () => {
  for (const [name, digest] of Object.entries(released)) {
    const sql = await readFile(new URL(`db/migrations/${name}`, root));
    assert.equal(createHash("sha256").update(sql).digest("hex"), digest, name);
  }
});

test("production and isolated tests use one D1 migration history without a DB package", async () => {
  const config = await read("wrangler.jsonc");
  const directories = [
    ...config.matchAll(/"migrations_dir":\s*"(?<path>[^"]+)"/gu),
  ];
  assert.deepEqual(
    directories.map((match) => match.groups?.path),
    ["db/migrations"]
  );
  const local = JSON.parse(await read("db/tests/wrangler.test.json"));
  assert.equal(local.d1_databases.length, 1);
  assert.equal(local.d1_databases[0].migrations_dir, "../migrations");
  assert.equal(
    local.d1_databases[0].database_id,
    "00000000-0000-0000-0000-000000000000"
  );
  assert.equal(local.d1_databases[0].remote, false);
  const runner = await read("api/tests/run.ts");
  assert.ok(runner.includes('readdir("db/migrations")'));
  assert.ok(runner.includes('nodePath.join("db/migrations", name)'));
  for (const path of [
    "db/d1",
    "db/package.json",
    "db/bunfig.toml",
    "db/.gitignore",
    "db/tests/.gitignore",
  ]) {
    assert.equal(existsSync(new URL(path, root)), false, path);
  }
  const manifest = JSON.parse(await read("package.json"));
  assert.deepEqual(manifest.workspaces, ["web"]);
  assert.equal(manifest.scripts["test:postgres-import"], undefined);
  assert.equal(manifest.dependencies?.postgres, undefined);
  assert.equal(manifest.devDependencies?.postgres, undefined);
  // Drizzle declares optional drivers for other backends. Their peer metadata
  // is not an installed package; reject resolved PostgreSQL entries instead.
  assert.doesNotMatch(
    await read("bun.lock"),
    /^\s*"(?:[^"\n]+\/)?postgres"\s*:\s*\[|personal-trainer-d1-migration/mu
  );
});

test("root ignore rules protect nested database artifacts without hiding migrations", () => {
  for (const [path, expectedStatus] of [
    ["node_modules/example/index.js", 0],
    ["web/node_modules/example/index.js", 0],
    ["db/tests/node_modules/example/index.js", 0],
    ["db/tests/.wrangler/state.sqlite", 0],
    ["db/tests/.dev.vars", 0],
    ["db/tests/.dev.vars-preview", 0],
    ["db/tests/.env", 0],
    ["db/tests/private.snapshot.json", 0],
    ["db/tests/private.import.sql", 0],
    ["db/migrations/0001_record.sql", 1],
    ["db/migrations/meta/0004_snapshot.json", 1],
    ["db/migrations/meta/_journal.json", 1],
    ["db/tests/fixtures/storage.json", 1],
  ] as const) {
    const result = spawnSync("git", ["check-ignore", "--no-index", path], {
      cwd: root,
      encoding: "utf-8",
    });
    assert.equal(result.status, expectedStatus, path);
  }
});
