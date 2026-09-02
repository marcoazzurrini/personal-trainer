// Applying the SQL in db/migrations to a database, once each, in name order.
//
// A migration is a plain .sql file named <version>_<slug>.sql, where the
// version is a timestamp, so sorting by name is sorting by time. Each file
// runs in a transaction of its own and, in the same transaction, records its
// version in public.schema_migrations; a file that fails leaves nothing
// behind and stops the run. An advisory lock keeps two containers starting
// at once from racing each other.
//
// Modes, from the command line:
//   (none)      apply every file not yet recorded
//   --status    print what is applied and what is pending, change nothing
//   --baseline  record every file as applied without running it — for a
//               database restored from a dump that already holds the schema
//
// Run with: deno task migrate [--status|--baseline]

import postgres, { type Sql } from "postgres";

export type Mode = "apply" | "status" | "baseline";

export interface Migration {
  version: string;
  file: string;
}

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

// The files, in the order they apply. Anything that is not a .sql file is
// ignored, so an editor's stray file cannot become a migration.
export async function listMigrations(
  dir: URL = MIGRATIONS_DIR,
): Promise<Migration[]> {
  const found: Migration[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    found.push({ version: entry.name.slice(0, -4), file: entry.name });
  }
  return found.sort((a, b) => a.version.localeCompare(b.version));
}

// The files whose version the database has not recorded, in order.
export function pending(
  all: Migration[],
  applied: Iterable<string>,
): Migration[] {
  const done = new Set(applied);
  return all.filter((m) => !done.has(m.version));
}

async function ensureTable(sql: Sql): Promise<void> {
  await sql`
    create table if not exists public.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `;
}

async function appliedVersions(sql: Sql): Promise<string[]> {
  const rows = await sql<{ version: string }[]>`
    select version from public.schema_migrations order by version
  `;
  return rows.map((r) => r.version);
}

export interface Report {
  applied: string[];
  ran: string[];
  pending: string[];
}

// Runs one mode against the database at url. The connection pool is one
// connection deep on purpose: the advisory lock is session-scoped, and it
// must be the same session that runs the files.
export async function migrate(
  url: string,
  mode: Mode = "apply",
  dir: URL = MIGRATIONS_DIR,
): Promise<Report> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await ensureTable(sql);
    await sql`select pg_advisory_lock(hashtext('schema_migrations'))`;
    try {
      const all = await listMigrations(dir);
      const applied = await appliedVersions(sql);
      const todo = pending(all, applied);
      const ran: string[] = [];

      if (mode === "status") {
        return { applied, ran, pending: todo.map((m) => m.version) };
      }

      for (const m of todo) {
        const text = mode === "apply"
          ? await Deno.readTextFile(new URL(m.file, dir))
          : null;
        await sql.begin(async (tx) => {
          if (text !== null) await tx.unsafe(text);
          await tx`insert into public.schema_migrations (version) values (${m.version})`;
        });
        ran.push(m.version);
      }
      return { applied: [...applied, ...ran], ran, pending: [] };
    } finally {
      await sql`select pg_advisory_unlock(hashtext('schema_migrations'))`;
    }
  } finally {
    await sql.end();
  }
}

function parseMode(args: string[]): Mode {
  if (args.length === 0) return "apply";
  if (args.length === 1 && args[0] === "--status") return "status";
  if (args.length === 1 && args[0] === "--baseline") return "baseline";
  throw new Error(
    `usage: migrate.ts [--status|--baseline], got ${args.join(" ")}`,
  );
}

if (import.meta.main) {
  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    console.error("DATABASE_URL is not set");
    Deno.exit(2);
  }
  try {
    const mode = parseMode(Deno.args);
    const report = await migrate(url, mode);
    if (mode === "status") {
      console.log(`${report.applied.length} applied`);
      for (const v of report.pending) console.log(`pending  ${v}`);
      if (report.pending.length === 0) console.log("nothing pending");
    } else {
      const verb = mode === "apply" ? "applied" : "recorded";
      for (const v of report.ran) console.log(`${verb}  ${v}`);
      if (report.ran.length === 0) console.log("nothing to do");
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
