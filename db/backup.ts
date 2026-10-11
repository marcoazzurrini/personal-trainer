import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

// A portable copy of the production record, kept off the Cloudflare account.
// D1 Time Travel only reaches back a limited window and lives in the same
// account it would be protecting. The export contains health records and
// provider credentials, so it is written owner-only, outside the repository,
// and never uploaded anywhere by this script.

const root = nodePath.resolve(import.meta.dirname, "..");
const wrangler = nodePath.resolve(
  root,
  "node_modules/wrangler/bin/wrangler.js"
);

// Tables a real record cannot have emptied. An export that restores them empty
// is a failed backup, whatever the integrity checks say.
export const REQUIRED_TABLES = [
  "exercises",
  "sessions",
  "sets",
  "intake_entries",
  "bodyweight",
];

export function backupDestination(value?: string): string {
  if (!value) {
    throw new Error(
      "Set TRAINER_BACKUP_DIR to an absolute, private directory outside the repository, e.g. TRAINER_BACKUP_DIR=~/Backups/personal-trainer bun run backup."
    );
  }
  if (!nodePath.isAbsolute(value)) {
    throw new Error(
      `TRAINER_BACKUP_DIR must be an absolute path; got "${value}".`
    );
  }
  const destination = nodePath.resolve(value);
  const relative = nodePath.relative(root, destination);
  if (!relative.startsWith("..") && !nodePath.isAbsolute(relative)) {
    throw new Error(
      "TRAINER_BACKUP_DIR is inside the repository. An export holds private records and credentials; keep it outside Git."
    );
  }
  return destination;
}

// Restore the export into a fresh in-memory SQLite database and read it back.
// D1 is SQLite, so this is a real restore of the file, not a parse. It proves
// the file loads, its foreign keys hold, its views still answer and the core
// tables are not empty. It does not exercise the API against the copy.
export function verifyExport(
  sql: string,
  required: readonly string[] = REQUIRED_TABLES
) {
  // Load without enforcement, as an export's table order need not follow its
  // references, then ask SQLite for every row whose reference does not hold.
  const db = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: false,
  });
  try {
    db.exec(sql);
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new Error("The restored export fails SQLite's integrity check.");
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error(
        "The restored export has rows with dangling foreign keys."
      );
    }
    const views = z
      .array(z.object({ name: z.string() }))
      .parse(
        db.prepare("SELECT name FROM sqlite_schema WHERE type = 'view'").all()
      );
    for (const { name } of views) {
      db.prepare(`SELECT count(*) FROM "${name}"`).get();
    }
    const counts = new Map<string, number>();
    for (const table of required) {
      const { n } = z
        .object({ n: z.number() })
        .parse(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get());
      if (n === 0) {
        throw new Error(`The restored export has no rows in "${table}".`);
      }
      counts.set(table, n);
    }
    return Object.fromEntries(counts);
  } finally {
    db.close();
  }
}

export async function backup(destination: string, now = new Date()) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
  const stamp = now.toISOString().replaceAll(/[:.]/gu, "-");
  const file = nodePath.join(destination, `personal-trainer-${stamp}.sql`);
  const partial = `${file}.partial`;
  try {
    execFileSync(
      "node",
      [
        wrangler,
        "d1",
        "export",
        "personal-trainer",
        "--remote",
        "--output",
        partial,
      ],
      {
        cwd: root,
        // Wrangler prints a presigned download link for the whole export on
        // stdout. Keep it out of terminals and logs; errors still reach stderr.
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      }
    );
    await chmod(partial, 0o600);
    const sql = await readFile(partial, "utf-8");
    const counts = verifyExport(sql);
    await rename(partial, file);
    const digest = createHash("sha256").update(sql).digest("hex");
    await writeFile(
      `${file}.sha256`,
      `${digest}  ${nodePath.basename(file)}\n`,
      {
        mode: 0o600,
      }
    );
    return { file, digest, counts };
  } finally {
    await rm(partial, { force: true });
  }
}

if (
  process.argv[1] &&
  nodePath.resolve(process.argv[1]) === import.meta.filename
) {
  const { file, counts } = await backup(
    backupDestination(process.env.TRAINER_BACKUP_DIR)
  );
  console.log(`Verified backup ${file}`);
  console.log(
    Object.entries(counts)
      .map(([table, n]) => `${table}: ${n}`)
      .join(", ")
  );
}
