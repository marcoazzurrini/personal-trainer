// Only scripts/test.ts creates this receipt, from a fresh Docker container's
// pg_control_system() identity. A URL (even loopback) is never permission to write.
import postgres, { type Sql } from "postgres";

export interface DatabaseIdentity {
  systemId: string;
  database: string;
}

export interface Disposable extends DatabaseIdentity {
  kind: "personal-trainer-disposable-v1";
  containerId: string;
  databaseUrl: string;
  apiUrl: string;
}

const REFUSAL =
  "Unsafe test database: run deno task test to create a disposable database.";

export function parseDisposable(value: unknown): Disposable {
  const d = value as Disposable | null;
  if (
    !d || d.kind !== "personal-trainer-disposable-v1" ||
    !/^[a-f0-9]{64}$/.test(d.containerId ?? "") ||
    !/^\d{19,20}$/.test(d.systemId ?? "") ||
    !/^pt_test_[a-f0-9]{32}$/.test(d.database ?? "")
  ) throw new Error(REFUSAL);
  const db = new URL(d.databaseUrl);
  const api = new URL(d.apiUrl);
  if (
    db.protocol !== "postgresql:" || db.pathname !== `/${d.database}` ||
    db.hostname !== "127.0.0.1" || api.protocol !== "http:" ||
    api.hostname !== "127.0.0.1" || api.pathname !== "/api"
  ) throw new Error(REFUSAL);
  return d;
}

// The readiness file can be observed after creation but before writing finishes.
export function readyApiUrl(value: string): string | undefined {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/api$/.exec(value);
  return match?.[0] === value && Number(match[1]) <= 65535 ? value : undefined;
}

export async function disposable(): Promise<Disposable> {
  const file = Deno.env.get("TEST_DISPOSABLE_FILE");
  if (!file) throw new Error(REFUSAL);
  const d = parseDisposable(JSON.parse(await Deno.readTextFile(file)));
  for (
    const [key, expected] of [
      ["DATABASE_URL", d.databaseUrl],
      ["TEST_DATABASE_URL", d.databaseUrl],
      ["API_URL", d.apiUrl],
    ]
  ) {
    const actual = Deno.env.get(key);
    if (actual !== undefined && actual !== expected) {
      throw new Error(`${REFUSAL} ${key} does not match the receipt.`);
    }
  }
  return d;
}

export function assertIdentity(
  expected: DatabaseIdentity,
  actual: unknown,
): void {
  const row = actual as DatabaseIdentity | null;
  if (
    !row || row.systemId !== expected.systemId ||
    row.database !== expected.database
  ) {
    throw new Error(`${REFUSAL} Database identity does not match the receipt.`);
  }
}

export async function databaseIdentity(sql: Sql): Promise<DatabaseIdentity> {
  const [row] = await sql`
    select system_identifier::text as "systemId", current_database() as database
    from pg_control_system()`;
  return row as DatabaseIdentity;
}

export async function verifyDatabase(
  d: DatabaseIdentity,
  url: string,
): Promise<void> {
  // This connection can only read, including while checking an unrecognized DB.
  const sql = postgres(url, {
    max: 1,
    connection: { default_transaction_read_only: true },
  });
  try {
    assertIdentity(d, await databaseIdentity(sql));
  } finally {
    await sql.end();
  }
}

export async function verifiedDatabase(): Promise<Disposable> {
  const d = await disposable();
  await verifyDatabase(d, d.databaseUrl);
  return d;
}

export async function verifyApi(d: Disposable): Promise<void> {
  // Never probe /health: it can sync Withings. This read-only route exists only
  // in api/tests/serve.ts, and reads the very sql singleton the API operations use.
  const res = await fetch(`${d.apiUrl}/__test_identity`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${REFUSAL} API has no disposable identity.`);
  }
  assertIdentity(d, await res.json());
}
