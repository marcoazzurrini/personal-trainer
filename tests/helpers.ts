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
  return { status: res.status, body: await res.json() };
}

export const api = {
  get: (path: string, token?: string | null) =>
    request("GET", path, undefined, token),
  post: (path: string, body: unknown, token?: string | null) =>
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
        mesocycle_exercises, mesocycles, blocks, user_context, bodyweight
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

// Loads the catalogue if this database has never seen it (fresh CI stack).
export async function ensureCatalogue() {
  const { body } = await api.get("/exercises");
  if (body.exercises.length === 0) await loadCatalogue(BASE, TOKEN);
}

// --- Date helpers. All calendar logic is Europe/Rome, like the API. ---

function romeToday(): Date {
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" })
    .format(new Date()); // YYYY-MM-DD
  return new Date(`${iso}T00:00:00Z`);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
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
