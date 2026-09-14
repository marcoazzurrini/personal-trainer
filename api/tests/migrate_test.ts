// The migration runner: every file once, in order, and a restored dump can be
// recorded as already applied.

import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import { listMigrations, migrate, pending } from "../../db/migrate.ts";

import { verifiedDatabase, verifyDatabase } from "./disposable.ts";

// A fresh random database in the owned disposable cluster. No pre-existing
// database is dropped; removing the container cleans up these scratch databases.
async function freshDatabase(): Promise<string> {
  const disposable = await verifiedDatabase();
  const scratch = `pt_migrate_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(disposable.databaseUrl, {
    max: 1,
    onnotice: () => {},
  });
  try {
    await admin.unsafe(`create database ${scratch}`);
  } finally {
    await admin.end();
  }
  const url = new URL(disposable.databaseUrl);
  url.pathname = `/${scratch}`;
  await verifyDatabase({ ...disposable, database: scratch }, url.toString());
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

Deno.test("migration SQL and its receipt roll back together, then retry", async () => {
  const url = await freshDatabase();
  const fixtures = new URL("./fixtures/migrations/", import.meta.url);
  const db = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await assertRejects(
      () => migrate(url, "apply", fixtures),
      Error,
      "injected failure after migration writes",
    );
    assertEquals(await migrate(url, "status", fixtures), {
      applied: ["001_initial"],
      ran: [],
      pending: ["002_upgrade", "003_after"],
    });
    assertEquals([...(await db`select * from fixture_records order by id`)], [{
      id: 1,
      value: "original",
    }]);
    assertEquals(
      (await tables(url)).includes("fixture_upgrade_artifact"),
      false,
    );

    // Repair the external prerequisite, not the migration or its receipt.
    await db`update fixture_control set allow_upgrade = true`;
    // SQL sent as one batch has its own implicit transaction. Failing inside
    // that batch alone cannot prove the runner includes the receipt in the
    // same transaction. Fail the separate receipt INSERT after SQL succeeds.
    await db`create function fail_migration_receipt() returns trigger language plpgsql as $$
      begin
        if new.version = '002_upgrade' then
          if not exists (select 1 from fixture_records where id = 1 and value = 'upgraded')
             or not exists (select 1 from fixture_upgrade_artifact where id = 1) then
            raise exception 'injection did not reach the receipt';
          end if;
          raise exception 'injected receipt failure';
        end if;
        return new;
      end $$`;
    await db`create trigger fail_migration_receipt before insert on schema_migrations
      for each row execute function fail_migration_receipt()`;
    await assertRejects(
      () => migrate(url, "apply", fixtures),
      Error,
      "injected receipt failure",
    );
    assertEquals((await migrate(url, "status", fixtures)).applied, [
      "001_initial",
    ]);
    assertEquals([...(await db`select * from fixture_records order by id`)], [{
      id: 1,
      value: "original",
    }]);
    assertEquals(
      (await tables(url)).includes("fixture_upgrade_artifact"),
      false,
    );
    await db`drop trigger fail_migration_receipt on schema_migrations`;
    await db`drop function fail_migration_receipt()`;
    assertEquals((await migrate(url, "apply", fixtures)).ran, [
      "002_upgrade",
      "003_after",
    ]);
    assertEquals([...(await db`select * from fixture_records order by id`)], [
      { id: 1, value: "upgraded" },
      { id: 2, value: "later migration" },
    ]);
    assertEquals([...(await db`select * from fixture_upgrade_artifact`)], [{
      id: 1,
    }]);
    assertEquals((await migrate(url, "apply", fixtures)).ran, []);
  } finally {
    await db.end();
  }
});

Deno.test("a populated historical schema upgrades without losing weigh-ins", async () => {
  const url = await freshDatabase();
  const all = await listMigrations();
  const cutoff = all.findIndex((m) =>
    m.version === "20260809210000_daily_bodyweight_tiebreak"
  );
  assert(cutoff > 0, "the historical upgrade boundary must exist");
  const db = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(url, "status");
    // Reconstruct the actual old schema from immutable historical SQL, not
    // from a hand-maintained copy of today's table definitions.
    for (const m of all.slice(0, cutoff)) {
      const text = await Deno.readTextFile(
        new URL(`../../db/migrations/${m.file}`, import.meta.url),
      );
      await db.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`insert into schema_migrations (version) values (${m.version})`;
      });
    }
    await db`insert into bodyweight (value_kg, measured_at, source) values
      (80.12, '2026-08-09T23:30:00Z', 'manual'),
      (90.34, '2026-08-09T23:30:00Z', 'withings'),
      (82.56, '2026-08-10T18:00:00Z', 'manual')`;
    const before = [...await db`select * from bodyweight order by id`];
    const upgraded = await migrate(url);
    assertEquals(upgraded.ran, all.slice(cutoff).map((m) => m.version));
    assertEquals([...await db`select * from bodyweight order by id`], before);
    assertEquals([
      ...await db`select day::text, value_kg from daily_bodyweight`,
    ], [
      { day: "2026-08-10", value_kg: 80.12 },
    ]);
    assertEquals((await migrate(url)).ran, []);
    assertEquals([...await db`select * from bodyweight order by id`], before);
  } finally {
    await db.end();
  }
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
