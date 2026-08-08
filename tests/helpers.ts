import postgres from "postgres";
import { loadCatalogue } from "../scripts/load_catalogue.ts";

export const BASE = Deno.env.get("API_URL") ??
  "http://127.0.0.1:54321/functions/v1/api";
export const TOKEN = Deno.env.get("API_TOKEN") ?? "local-dev-token";
const DB_URL = Deno.env.get("TEST_DATABASE_URL") ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export interface ApiResponse {
  status: number;
  // deno-lint-ignore no-explicit-any
  body: any;
}

// Every error this API returns is exactly { "error": "<a sentence>" } — no
// stack trace, no HTML, no bare status, no extra fields. The client is a model
// that has to decide what to do next from the body alone, so the envelope is
// part of the contract rather than a formatting habit.
//
// Enforced here, on every call every test makes, instead of as a suite of its
// own. A suite could only ever sample the endpoints someone thought to list;
// this covers whichever path a test happens to walk down, including the ones
// reached by accident.
function assertErrorEnvelope(
  status: number,
  body: unknown,
  method: string,
  path: string,
): void {
  if (status < 400) return;
  const error = (body as { error?: unknown } | null)?.error;
  const keys = body !== null && typeof body === "object"
    ? Object.keys(body)
    : [];
  if (typeof error !== "string" || error.trim() === "" || keys.length !== 1) {
    throw new Error(
      `${method} ${path} answered ${status} with ${
        JSON.stringify(body)
      } — every error must be exactly { "error": "<message>" }.`,
    );
  }
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await res.json();
  assertErrorEnvelope(res.status, parsed, method, path);
  return { status: res.status, body: parsed };
}

// Creating POSTs require a request_id, so api.post supplies one when the test
// hasn't. Every real caller sends one; making 88 test bodies carry the
// boilerplate would bury what each test is actually asserting. Tests that
// pass an explicit id (to exercise a retry) keep theirs, and postRaw sends the
// body untouched so the requirement itself can be tested.
function withRequestId(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return body;
  }
  const b = body as Record<string, unknown>;
  return "request_id" in b ? b : { ...b, request_id: uuid() };
}

export const api = {
  get: (path: string, token?: string | null) =>
    request("GET", path, undefined, token),
  post: (path: string, body: unknown, token?: string | null) =>
    request("POST", path, withRequestId(body), token),
  postRaw: (path: string, body: unknown, token?: string | null) =>
    request("POST", path, body, token),
  patch: (path: string, body: unknown, token?: string | null) =>
    request("PATCH", path, body, token),
  delete: (path: string, token?: string | null) =>
    request("DELETE", path, undefined, token),
};

// Wipes the training record and plan, keeping the exercise catalogue.
// Listing every table in one statement lets Postgres order the FK deletes.
export async function resetTraining() {
  const db = postgres(DB_URL);
  try {
    await db`
      truncate table sets, sessions, mesocycle_decisions,
        mesocycle_exercises, mesocycles, blocks, user_context, bodyweight,
        week_schedules
      restart identity`;
  } finally {
    await db.end();
  }
}

// Wipes the food registry and everything eaten. Separate from resetTraining:
// the two halves of the coach share a database but not a test fixture.
export async function resetNutrition() {
  const db = postgres(DB_URL);
  try {
    await db`
      truncate table intake_entries, meal_items, meal_aliases, meals,
        food_aliases, foods, day_flags, bodyfat_estimates, bodyweight,
        nutrition_targets, nutrition_events
      restart identity`;
  } finally {
    await db.end();
  }
}

/** The Sunday that ended the most recent finished Rome week. */
export function lastFinishedSunday(): string {
  const monday = new Date(`${thisMonday()}T00:00:00Z`);
  return isoDate(addDays(monday, -1));
}

interface CutSeed {
  days: number;
  kcal: number;
  startWeightKg: number;
  kgPerWeek: number;
  /** Leave the most recent N days unlogged and unweighed — a lapse. */
  skipLastDays?: number;
}

// Seeds a history through the API rather than the database, so the tests
// exercise the same writes the coach uses. The window ends on the last
// finished Sunday, which is where the expenditure back-solve looks.
export async function seedCut(seed: CutSeed) {
  const skip = seed.skipLastDays ?? 0;
  const end = new Date(`${lastFinishedSunday()}T00:00:00Z`);

  await api.post("/foods", {
    name: "Seed Food",
    kcal_100g: 100,
    protein_100g: 5,
    carbs_100g: 12,
    fat_100g: 3,
    source: "estimate",
    source_note: "test fixture",
    request_id: uuid(),
  });

  for (let i = seed.days - 1; i >= skip; i--) {
    const day = isoDate(addDays(end, -i));
    const elapsed = seed.days - 1 - i;
    const weight = seed.startWeightKg + seed.kgPerWeek / 7 * elapsed;
    await api.post("/bodyweight", {
      value_kg: Math.round(weight * 100) / 100,
      measured_at: `${day}T05:30:00Z`, // 07:30 Rome, a morning weigh-in
    });
    await api.post("/intake", {
      day,
      food: "Seed Food",
      grams: seed.kcal, // 100 kcal/100 g, so grams == kcal
      request_id: uuid(),
    });
  }
}

// --- Seeding the expenditure window ----------------------------------------
// seedCut above writes a whole coherent history in one call, which is what the
// end-to-end tests want. These pieces are the same writes taken apart, so a
// test can satisfy one requirement of the back-solve while starving another —
// which is how a threshold gets tested from both sides.

export const WINDOW_DAYS = 21; // DEFAULT_WINDOW_DAYS
export const MIN_USABLE_DAYS = 14; // MIN_WINDOW_DAYS

/** The window the estimate reads: N days ending at the last finished Sunday, oldest first. */
export function expenditureWindow(count = WINDOW_DAYS): string[] {
  const end = lastFinishedSunday();
  return Array.from(
    { length: count },
    (_, i) => daysBefore(end, count - 1 - i),
  );
}

/** 100 kcal/100 g, so grams and kcal are the same number and a seeded day says what it means. */
export async function seedFood(name = "Window Food") {
  await api.post("/foods", {
    name,
    kcal_100g: 100,
    protein_100g: 5,
    carbs_100g: 12,
    fat_100g: 3,
    source: "estimate",
    source_note: "test fixture",
    request_id: uuid(),
  });
}

/** A morning weigh-in on each listed day, on a steady trajectory. */
export async function seedWeighIns(
  days: string[],
  startKg = 82,
  kgPerWeek = -0.5,
) {
  for (const [i, day] of days.entries()) {
    await api.post("/bodyweight", {
      value_kg: Math.round((startKg + kgPerWeek / 7 * i) * 100) / 100,
      measured_at: `${day}T05:30:00Z`, // 07:30 Rome
    });
  }
}

export async function seedIntakeDays(
  days: string[],
  kcal: number,
  food = "Window Food",
) {
  for (const day of days) {
    await api.post("/intake", { day, food, grams: kcal, request_id: uuid() });
  }
}

export async function seedBodyfat(percent = 14, day = lastFinishedSunday()) {
  await api.post("/bodyfat", {
    percent,
    method: "bia",
    day,
    request_id: uuid(),
  });
}

// Loads the catalogue if this database has never seen it (fresh CI stack).
export async function ensureCatalogue() {
  const { body } = await api.get("/exercises");
  if (body.exercises.length === 0) await loadCatalogue(BASE, TOKEN);
}

// --- Date helpers. All calendar logic is Europe/Rome, like the API. ---

// Rome's today, read once from the clock the API itself uses.
//
// Computing it here with Intl instead looked equivalent and was not: the API
// asks Postgres for `now() at time zone 'Europe/Rome'`, so two clocks had to
// agree, and they disagree for the moments either side of midnight and
// whenever the container's zone data differs. A suite that seeds relative to
// "today" would then fail for reasons nothing to do with the code, rarely
// enough to be dismissed as flakiness and often enough to erode trust in a
// red run. One clock cannot disagree with itself.
//
// Read once at module load rather than per call, so every file in a run shares
// the same "today" even if the run straddles midnight — a suite that changed
// its mind halfway through would be worse than either answer.
const ROME_TODAY: string = await (async () => {
  const db = postgres(DB_URL);
  try {
    const [row] = await db`
      select (now() at time zone 'Europe/Rome')::date::text as today`;
    return row.today as string;
  } finally {
    await db.end();
  }
})();

function romeToday(): Date {
  return new Date(`${ROME_TODAY}T00:00:00Z`);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/** N days before a "YYYY-MM-DD", as another "YYYY-MM-DD". */
export function daysBefore(day: string, n: number): string {
  return isoDate(addDays(new Date(`${day}T00:00:00Z`), -n));
}

/** The Rome day N days back from today — the window suites count backwards. */
export function daysAgo(n: number): string {
  return daysBefore(today(), n);
}

/** Monday of the current Rome week. */
export function thisMonday(): string {
  const today = romeToday();
  const dow = today.getUTCDay(); // Sun=0 … Sat=6
  return isoDate(addDays(today, dow === 0 ? -6 : 1 - dow));
}

/** Monday of the previous Rome week — always a finished week. */
export function lastMonday(): string {
  const monday = new Date(`${thisMonday()}T00:00:00Z`);
  return isoDate(addDays(monday, -7));
}

/** A day inside last week (its Tuesday). */
export function lastTuesday(): string {
  const monday = new Date(`${lastMonday()}T00:00:00Z`);
  return isoDate(addDays(monday, 1));
}

export function today(): string {
  return isoDate(romeToday());
}

export function uuid(): string {
  return crypto.randomUUID();
}
