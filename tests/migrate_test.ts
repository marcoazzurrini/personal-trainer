// The migration runner: every file once, in order, and a restored dump can be
// recorded as already applied.

import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import { listMigrations, migrate, pending } from "../db/migrate.ts";

const ADMIN_URL = Deno.env.get("TEST_DATABASE_URL") ??
  "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const SCRATCH = "pt_migrate_test";

// A database of its own, dropped and recreated, so the runner is exercised
// from nothing without touching the one the other tests share.
async function freshDatabase(): Promise<string> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${SCRATCH} with (force)`);
    await admin.unsafe(`create database ${SCRATCH}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH}`;
  return url.toString();
}

async function tables(url: string): Promise<string[]> {
  const db = postgres(url, { max: 1 });
  try {
    const rows = await db<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name
    `;
    return rows.map((r) => r.table_name);
  } finally {
    await db.end();
  }
}

Deno.test("pending is the ordered difference", () => {
  const all = [
    { version: "20260101000000_a", file: "20260101000000_a.sql" },
    { version: "20260102000000_b", file: "20260102000000_b.sql" },
    { version: "20260103000000_c", file: "20260103000000_c.sql" },
  ];
  assertEquals(pending(all, ["20260102000000_b"]).map((m) => m.version), [
    "20260101000000_a",
    "20260103000000_c",
  ]);
  assertEquals(pending(all, all.map((m) => m.version)), []);
});

Deno.test("the files are sorted by name and all are .sql", async () => {
  const all = await listMigrations();
  assert(all.length > 0);
  const versions = all.map((m) => m.version);
  assertEquals(versions, [...versions].sort());
  for (const m of all) assert(m.file === `${m.version}.sql`);
});

Deno.test("apply runs every file once, then nothing", async () => {
  const url = await freshDatabase();
  const all = await listMigrations();

  const first = await migrate(url, "apply");
  assertEquals(first.ran, all.map((m) => m.version));
  assertEquals(first.pending, []);
  assert((await tables(url)).includes("users"), "the schema was built");

  const second = await migrate(url, "apply");
  assertEquals(second.ran, []);
  assertEquals(second.applied.length, all.length);

  const status = await migrate(url, "status");
  assertEquals(status.pending, []);
  assertEquals(status.applied.length, all.length);
});

Deno.test("baseline records every file without running it", async () => {
  const url = await freshDatabase();
  const all = await listMigrations();

  const status = await migrate(url, "status");
  assertEquals(status.pending.length, all.length);

  const report = await migrate(url, "baseline");
  assertEquals(report.ran, all.map((m) => m.version));
  assertEquals(await tables(url), ["schema_migrations"]);

  const after = await migrate(url, "apply");
  assertEquals(after.ran, []);
});
