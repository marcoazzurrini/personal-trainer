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
