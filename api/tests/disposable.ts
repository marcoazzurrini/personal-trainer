// Only the local Miniflare runner issues this capability. A URL alone never
// grants fixture access. Both bridges prove the same randomly owned D1 binding.
export interface DatabaseIdentity {
  kind: "personal-trainer-worker-d1-v1";
  run: string;
}
export interface Disposable extends DatabaseIdentity {
  secret: string;
  apiUrl: string;
  managementUrl: string;
}
const REFUSAL =
  "Unsafe test database: run deno task test to create a disposable Worker+D1 database.";
function localUrl(value: unknown, path: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return value === value.trim() && url.href === value &&
      url.protocol === "http:" && url.hostname === "127.0.0.1" &&
      Number(url.port) > 0 && url.pathname === path && !url.username &&
      !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
export function parseDisposable(value: unknown): Disposable {
  const d = value as Disposable | null;
  if (
    !d || d.kind !== "personal-trainer-worker-d1-v1" ||
    !/^[a-f0-9]{64}$/.test(d.run ?? "") ||
    !/^[a-f0-9]{64}$/.test(d.secret ?? "") ||
    !localUrl(d.apiUrl, "/api") || !localUrl(d.managementUrl, "/manage")
  ) {
    throw new Error(REFUSAL);
  }
  return d;
}
export function readyApiUrl(value: string): string | undefined {
  return localUrl(value, "/api") ? value : undefined;
}
export async function disposable(): Promise<Disposable> {
  const file = Deno.env.get("TEST_DISPOSABLE_FILE");
  if (!file) throw new Error(REFUSAL);
  const d = parseDisposable(JSON.parse(await Deno.readTextFile(file)));
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL"]) {
    if (Deno.env.get(key) !== undefined) {
      throw new Error(`${REFUSAL} ${key} must not be set.`);
    }
  }
  const api = Deno.env.get("API_URL");
  if (api !== undefined && api !== d.apiUrl) {
    throw new Error(`${REFUSAL} API_URL does not match the receipt.`);
  }
  return d;
}
export function assertIdentity(
  expected: DatabaseIdentity,
  actual: unknown,
): void {
  const row = actual as DatabaseIdentity | null;
  if (!row || row.kind !== expected.kind || row.run !== expected.run) {
    throw new Error(`${REFUSAL} Database identity does not match the receipt.`);
  }
}
export async function management<T>(
  d: Disposable,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(d.managementUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: {
      authorization: `Bearer ${d.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...extra, run: d.run, action }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? REFUSAL);
  return body as T;
}
export async function verifyDatabase(d: Disposable): Promise<void> {
  assertIdentity(d, await management(d, "identity"));
}
export async function verifyApi(d: Disposable): Promise<void> {
  const res = await fetch(`${d.apiUrl}/__test_identity`, {
    headers: { authorization: `Bearer ${d.secret}` },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${REFUSAL} API has no disposable identity.`);
  }
  assertIdentity(d, await res.json());
}
export async function verifiedDatabase(): Promise<Disposable> {
  const d = await disposable();
  await verifyDatabase(d);
  await verifyApi(d);
  return d;
}
