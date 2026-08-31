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
  if (res.status < 400) {
    assertMatchesDocument(method, path, res.status, parsed);
  }
  return { status: res.status, body: parsed };
}

// --- The declared success shapes, checked against every answer ---------------
//
// The error envelope is one half of the contract; the declared response shape
// is the other. @hono/zod-openapi validates requests, not responses, so the
// schema and the SQL that fills it are two copies of one truth with nothing
// holding them together: /openapi.json can describe a field the SQL stopped
// returning, and every test stays green. Checked here, beside the envelope,
// for the same reason — on every call every test makes, covering whichever
// path a test happens to walk down, including the ones reached by accident.

import { Ajv, type ValidateFunction } from "ajv";

/** A parsed JSON object, guarded at every use. */
type Node = Record<string, unknown>;

function record(value: unknown): Node | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Node // checked: reached only through the guard above
    : null;
}

// zod-to-openapi writes nullability in OpenAPI 3.0's "nullable: true", which
// JSON Schema does not understand. Resolved once, at load, into the type
// array that means the same thing.
function resolveNullable(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) resolveNullable(child);
    return;
  }
  const object = record(node);
  if (object === null) return;
  if (object.nullable === true && typeof object.type === "string") {
    object.type = [object.type, "null"];
  }
  delete object.nullable;
  for (const child of Object.values(object)) resolveNullable(child);
}

interface DeclaredRoute {
  /** The path template split into segments, without the leading "/api" mount. */
  segments: string[];
  method: string;
  /** Declared status -> response schema; null where the route declares prose only. */
  schemaFor: Map<string, Node | null>;
  compiledFor: Map<string, ValidateFunction>;
}

// Read once, like Rome's today: the document is the contract, and reading it
// per call would let two copies disagree about what was promised. No token —
// /openapi.json is public, and what it publishes is the shape, not the data.
const DECLARED_ROUTES: DeclaredRoute[] = await (async () => {
  const response = await fetch(`${BASE}/openapi.json`);
  const document = record(await response.json());
  if (document === null || record(document.paths) === null) {
    throw new Error("/openapi.json did not answer with a document");
  }
  const methods = new Set(["get", "post", "patch", "put", "delete"]);
  const routes: DeclaredRoute[] = [];
  for (const [template, pathItem] of Object.entries(document.paths as Node)) {
    const operations = record(pathItem);
    if (operations === null) continue;
    for (const [method, operation] of Object.entries(operations)) {
      if (!methods.has(method)) continue; // the document keys methods lowercase; request() sends uppercase
      const responses = record(operation)?.responses;
      const schemaFor = new Map<string, Node | null>();
      for (const [status, entry] of Object.entries(record(responses) ?? {})) {
        const json = record(record(entry)?.content)?.["application/json"];
        schemaFor.set(status, record(record(json)?.schema));
      }
      routes.push({
        segments: template
          .replace(/^\/api(?=\/|$)/, "")
          .split("/")
          .filter((segment) => segment !== ""),
        method: method.toUpperCase(),
        schemaFor,
        compiledFor: new Map(),
      });
    }
  }
  resolveNullable(document);
  return routes;
})();

// strict: false because the document is OpenAPI, which carries keywords a
// plain JSON Schema validator would reject (description, example).
const ajv = new Ajv({ strict: false });

// A union — z.union emits anyOf — answers under one of its branches, so the
// extra keys are judged inside the branch that matched, not against the union
// as a whole.
const branchValidators = new WeakMap<Node, ValidateFunction>();

function branchFor(branches: Node[], value: unknown): Node | null {
  for (const branch of branches) {
    let validate = branchValidators.get(branch);
    if (validate === undefined) {
      validate = ajv.compile(branch);
      branchValidators.set(branch, validate);
    }
    if (validate(value)) return branch;
  }
  return null; // no branch matched: ajv has already said so above
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function matchDeclared(method: string, path: string): DeclaredRoute | null {
  const parts = path.split("?")[0].split("/").filter((p) => p !== "");
  outer: for (const route of DECLARED_ROUTES) {
    if (route.method !== method || route.segments.length !== parts.length) {
      continue;
    }
    for (let i = 0; i < parts.length; i++) {
      const template = route.segments[i];
      const isParameter = template.startsWith("{");
      if (!isParameter && template !== decode(parts[i])) continue outer;
    }
    return route;
  }
  return null;
}

// Drift runs in two directions, and only one of them is a validation
// failure. A field the SQL dropped breaks the schema; a field the SQL added
// that the document never promised breaks nothing at all, because a schema
// that says nothing about extra keys permits them. Both are drift, so both
// are looked for explicitly: the caller's next call is built from the answer,
// and an undeclared field is one the document never admitted to.
function collectExtras(
  schema: Node | null,
  value: unknown,
  at: string,
  extras: string[],
): void {
  const branches = schema !== null && Array.isArray(schema.anyOf)
    ? schema.anyOf.filter((b): b is Node => record(b) !== null)
    : null;
  if (branches !== null) {
    const branch = branchFor(branches, value);
    if (branch !== null) collectExtras(branch, value, at, extras);
    return;
  }
  const object = record(value);
  if (object !== null) {
    const properties = record(schema?.properties);
    for (const key of Object.keys(object)) {
      if (properties === null || !(key in properties)) {
        extras.push(`${at}${at === "" ? "" : "."}${key}`);
        continue; // no schema to compare against under an undeclared key
      }
      collectExtras(
        record(properties[key]),
        object[key],
        `${at}${at === "" ? "" : "."}${key}`,
        extras,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    const items = record(schema?.items);
    value.forEach((item, i) =>
      collectExtras(items, item, `${at}[${i}]`, extras)
    );
  }
}

function assertMatchesDocument(
  method: string,
  path: string,
  status: number,
  body: unknown,
): void {
  // Surfaces deliberately outside the document — the Withings webhook, the
  // uptime probe, the document itself — match nothing here, and that is the
  // exemption: the document is the contract, and what it does not describe is
  // not checked against it.
  const route = matchDeclared(method, path);
  if (route === null) return;
  const schema = route.schemaFor.get(String(status));
  if (schema === undefined) {
    throw new Error(
      `${method} ${path} answered ${status}, which its route does not declare ` +
        `— declared: ${[...route.schemaFor.keys()].join(", ")}. The document ` +
        `is generated from the routes, so the code and the description have split.`,
    );
  }
  if (schema === null) return; // declared, but as prose alone (the markdown docs)

  let validate = route.compiledFor.get(String(status));
  if (validate === undefined) {
    validate = ajv.compile(schema);
    route.compiledFor.set(String(status), validate);
  }
  const problems: string[] = [];
  if (!validate(body)) {
    for (const error of validate.errors ?? []) {
      problems.push(
        `${error.instancePath || "(root)"} ${error.message ?? "is not valid"}`,
      );
    }
  }
  const extras: string[] = [];
  collectExtras(schema, body, "", extras);
  for (const extra of extras) problems.push(`${extra} is not in the document`);
  if (problems.length > 0) {
    throw new Error(
      `${method} ${path} answered ${status} with ${JSON.stringify(body)} ` +
        `— ${problems.join("; ")}. The schema and the SQL have drifted; ` +
        `whichever is wrong, fix it.`,
    );
  }
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
  put: (path: string, body: unknown, token?: string | null) =>
    request("PUT", path, body, token),
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
        mesocycle_exercise_doses, mesocycle_exercises, mesocycles, blocks,
        user_context, bodyweight, week_schedules
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

// Empties the Withings credentials. The route suite asserts what an
// unconfigured install does, and an empty table is precisely that state — but
// the more important reason is that a seeded row would make those tests place
// real calls to Withings with a live token. A test run must not be able to
// touch the outside world by inheriting local state.
export async function resetWithings() {
  const db = postgres(DB_URL);
  try {
    await db`truncate table withings_auth`;
  } finally {
    await db.end();
  }
}

/** The Sunday that ended the most recent finished Rome week. */
export function lastFinishedSunday(): string {
  return lastFinishedSundayOf(ROME_TODAY);
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
  const end = lastFinishedSunday();

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
    const day = daysBefore(end, i);
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

// Imported, not restated: a restated literal would keep the seeded window and
// the assertions self-consistent with each other while the route read a
// different number — the threshold tests would pass while pinning the wrong
// value.
import {
  DEFAULT_WINDOW_DAYS as WINDOW_DAYS,
  MIN_WINDOW_DAYS as MIN_USABLE_DAYS,
} from "../supabase/functions/api/rules/expenditure.ts";
export { MIN_USABLE_DAYS, WINDOW_DAYS };
import {
  addDays,
  lastFinishedSunday as lastFinishedSundayOf,
  mondayOf,
} from "../supabase/functions/api/rules/dates.ts";

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

// --- Seeding a training plan ------------------------------------------------

export interface PlanExercise {
  exercise: string;
  role?: string;
  priority?: number;
  weekly_dose?: number;
  weekly_dose_unit?: string;
  notes?: string;
}

// The block-and-mesocycle scaffolding the training suites used to retype.
// The exercises are each test's substance and stay explicit at the call
// site; everything else defaults to the common shape — hypertrophy, four
// weeks, started last Monday, so "today" sits in week two. Throws with the
// server's own message on failure: a fixture that cannot be built should
// fail the run by saying why, not by cascading.
export async function seedPlan(opts: {
  exercises: PlanExercise[];
  name?: string;
  track?: string;
  intent?: string;
  planned_weeks?: number;
  sessions_per_week?: number;
  started_on?: string;
  /** Reuse an existing block — a second track running alongside the first. */
  blockId?: number;
}): Promise<{
  blockId: number;
  mesocycleId: number;
  /** The created mesocycle as the API answered it, for asserting against. */
  // deno-lint-ignore no-explicit-any
  mesocycle: any;
}> {
  const startedOn = opts.started_on ?? lastMonday();
  let blockId = opts.blockId;
  if (blockId === undefined) {
    const block = await api.post("/blocks", {
      name: "Test block",
      goal: "testing",
      started_on: startedOn,
    });
    if (block.status !== 201) {
      throw new Error(`seedPlan block: ${block.body.error}`);
    }
    blockId = block.body.block.id;
  }
  const meso = await api.post("/mesocycles", {
    request_id: uuid(),
    block_id: blockId,
    name: opts.name ?? "Test meso",
    track: opts.track ?? "hypertrophy",
    intent: opts.intent ?? "Testing. Double progression 6-10.",
    planned_weeks: opts.planned_weeks ?? 4,
    sessions_per_week: opts.sessions_per_week ?? 3,
    started_on: startedOn,
    exercises: opts.exercises.map((e, i) => ({
      role: "main",
      priority: i + 1,
      weekly_dose: 10,
      weekly_dose_unit: "sets",
      ...e,
    })),
  });
  if (meso.status !== 201) {
    throw new Error(`seedPlan mesocycle: ${meso.body.error}`);
  }
  return {
    blockId: blockId!,
    mesocycleId: meso.body.mesocycle.id,
    mesocycle: meso.body.mesocycle,
  };
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

// The arithmetic on top of that anchor comes from rules/dates.ts — the same
// functions the API's own code uses, so the suite cannot disagree with the
// server about where a week starts. The reasoning above for the anchor
// applies to the week boundaries too: two implementations of "Monday" were
// two clocks waiting to disagree.

/** N days before a "YYYY-MM-DD", as another "YYYY-MM-DD". */
export function daysBefore(day: string, n: number): string {
  return addDays(day, -n);
}

/** The Rome day N days back from today — the window suites count backwards. */
export function daysAgo(n: number): string {
  return addDays(ROME_TODAY, -n);
}

/** Monday of the current Rome week. */
export function thisMonday(): string {
  return mondayOf(ROME_TODAY);
}

/** Monday of the previous Rome week — always a finished week. */
export function lastMonday(): string {
  return addDays(mondayOf(ROME_TODAY), -7);
}

/** A day inside last week (its Tuesday). */
export function lastTuesday(): string {
  return addDays(mondayOf(ROME_TODAY), -6);
}

export function today(): string {
  return ROME_TODAY;
}

export function uuid(): string {
  return crypto.randomUUID();
}
