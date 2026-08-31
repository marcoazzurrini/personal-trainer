// The log page namespace: /s/:public_id. Not part of the coach API — the
// page is server-rendered here, its posts land on sub-routes of the same
// path, and the handlers write to Postgres directly. Tokenless: the
// unguessable public_id is this namespace's auth. No coaching logic lives
// here; the page renders what it is given and posts back what was typed.

import { type Context, Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { resolveSetMesocycleId } from "../lib/resolve.ts";
import { assertEffort, assertSetMeasures } from "../lib/training.ts";

export const logPage = new Hono();

// The page's own validators. The coach API validates with schemas
// (lib/schema.ts), which say the same sentences and describe themselves into
// /openapi.json; this namespace is registered above the token middleware and
// was deliberately left alone — it is the one surface a browser talks to, its
// shapes are its own, and nothing is gained by describing them in a document
// the browser never reads.

type Body = Record<string, unknown>;

// request_id is universal, so no caller has to list it. Everything else a
// route accepts, it names.
const ALWAYS_ACCEPTED = "request_id";

// A field this endpoint does not read is refused, not dropped.
//
// Silence was the old behaviour and it is the worse failure: the client is a
// model that reasonably guesses at a parameter it has not seen documented,
// and a guess that is ignored returns 200 over a record that says something
// else. That is how `{"meal": "colazione", "scale": 0.5}` logged a whole
// breakfast — the write looked like it worked, and nothing downstream can
// tell an intended full portion from a silently unscaled half.
//
// The accepted list doubles as the prompt: a caller that got the name wrong
// is shown the names that exist, which is usually all it needed.
function assertKnownFields(
  obj: Body,
  accepts: readonly string[],
  what: string,
): void {
  const unknown = Object.keys(obj).filter(
    (k) => k !== ALWAYS_ACCEPTED && !accepts.includes(k),
  );
  if (unknown.length === 0) return;
  const named = unknown.map((k) => `"${k}"`).join(", ");
  throw new ApiError(
    422,
    `Unknown field${unknown.length > 1 ? "s" : ""} ${named} in ${what}. ` +
      `Accepted: ${[...accepts, ALWAYS_ACCEPTED].join(", ")}. ` +
      "An unrecognised field is refused rather than ignored: dropped in silence, " +
      "a guessed or misspelled name lets the call answer 200 while the record " +
      "says something other than what was meant.",
  );
}

// Every write names the fields it reads. The list is required rather than
// optional so a new route cannot quietly opt out of the check.
async function readJson(
  c: Context,
  accepts: readonly string[],
): Promise<Body> {
  let body: unknown;
  try {
    body = await c.req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error();
    }
  } catch {
    throw new ApiError(
      422,
      "The request body must be a JSON object. Send Content-Type: application/json.",
    );
  }
  assertKnownFields(body as Body, accepts, "the request body");
  return body as Body;
}

function optionalString(body: Body, field: string): string | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.trim() === "") {
    throw new ApiError(
      422,
      `"${field}" must be a non-empty string when present.`,
    );
  }
  return v.trim();
}

function requireOneOf<T extends string>(
  body: Body,
  field: string,
  choices: readonly T[],
  fallback?: T,
): T {
  const v = body[field] ?? fallback;
  if (
    typeof v !== "string" || !(choices as readonly string[]).includes(v)
  ) {
    throw new ApiError(
      422,
      `"${field}" must be one of: ${choices.join(", ")}.`,
    );
  }
  return v as T;
}

function requireInt(
  body: Body,
  field: string,
  opts: { min?: number } = {},
): number {
  const v = body[field];
  if (
    typeof v !== "number" || !Number.isInteger(v) ||
    (opts.min !== undefined && v < opts.min)
  ) {
    throw new ApiError(
      422,
      `"${field}" is required and must be an integer${
        opts.min !== undefined ? ` >= ${opts.min}` : ""
      }.`,
    );
  }
  return v;
}

function optionalInt(
  body: Body,
  field: string,
  opts: { min?: number } = {},
): number | null {
  if (body[field] === undefined || body[field] === null) return null;
  return requireInt(body, field, opts);
}

function optionalNumber(
  body: Body,
  field: string,
  opts: { min?: number } = {},
): number | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (
    typeof v !== "number" || !Number.isFinite(v) ||
    (opts.min !== undefined && v < opts.min)
  ) {
    throw new ApiError(
      422,
      `"${field}" must be a number${
        opts.min !== undefined ? ` >= ${opts.min}` : ""
      } when present.`,
    );
  }
  return v;
}

// Ids in a path. Number("notanid") is NaN, and a NaN reaching Postgres as a
// bigint throws where the handler can only answer "internal error" — a 500 at
// exactly the moment the caller most needs a prompt telling it what to send.
export function requireIdParam(value: string, what: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new ApiError(
      422,
      `"${value}" is not a valid ${what} id. Ids are positive whole numbers.`,
    );
  }
  return id;
}

// deno-lint-ignore no-explicit-any
async function sessionByPublicId(publicId: string): Promise<any> {
  const [session] = await sql`
    select id, public_id, date, rationale, notes, overall_feel,
      started_at, completed_at
    from sessions where public_id = ${publicId}`;
  if (!session) {
    throw new ApiError(404, "No session here. Check the link.");
  }
  return session;
}

// A set may only be written through the session link it belongs to.
async function setInSession(setId: number, sessionId: number) {
  const [row] = await sql`
    select t.id, t.kind, t.performed_at, t.effort, t.weight_kg::float8, t.reps,
      t.distance_m::float8, t.duration_s::float8,
      e.name as exercise, e.measure, e.stimulus_type
    from sets t join exercises e on e.id = t.exercise_id
    where t.id = ${setId} and t.session_id = ${sessionId}`;
  if (!row) throw new ApiError(404, "That set is not part of this session.");
  return row;
}

logPage.get("/:publicId", async (c) => {
  const session = await sessionByPublicId(c.req.param("publicId"));

  const sets = await sql`
    select t.id, t.exercise_id, e.name as exercise, e.measure, t.position,
      t.kind,
      t.target_weight_kg::float8, t.target_reps,
      t.target_distance_m::float8, t.target_duration_s::float8,
      t.weight_kg::float8, t.reps,
      t.distance_m::float8, t.duration_s::float8, t.effort, t.notes,
      me.notes as plan_notes
    from sets t
    join exercises e on e.id = t.exercise_id
    left join mesocycle_exercises me
      on me.mesocycle_id = t.mesocycle_id
      and me.exercise_id = t.exercise_id
    where t.session_id = ${session.id}
    order by t.position`;

  // Last time's numbers per exercise: the working sets of the most recent
  // earlier session that performed it.
  const exerciseIds = [...new Set(sets.map((s) => s.exercise_id))];
  const lastTime = exerciseIds.length === 0 ? [] : await sql`
    select x.exercise_id, prev.date,
      (select json_agg(json_build_object(
          'weight_kg', p.weight_kg::float8, 'reps', p.reps,
          'distance_m', p.distance_m::float8, 'duration_s', p.duration_s::float8,
          'effort', p.effort)
        order by p.position)
       from sets p
       where p.session_id = prev.id and p.exercise_id = x.exercise_id
         and p.kind = 'working'
         and set_performed(p.reps, p.distance_m, p.duration_s)) as sets
    from unnest(${sql.array(exerciseIds)}::bigint[]) as x(exercise_id)
    cross join lateral (
      select s2.id, s2.date
      from sessions s2
      join sets t2 on t2.session_id = s2.id
      where t2.exercise_id = x.exercise_id and t2.kind = 'working'
        and set_performed(t2.reps, t2.distance_m, t2.duration_s)
        and s2.id <> ${session.id}
        and s2.date <= ${session.date}
      order by s2.date desc, s2.id desc
      limit 1
    ) prev`;

  const catalogue = await sql`
    select id, name, measure from exercises order by name`;

  return c.html(renderPage(session, sets, lastTime, catalogue));
});

// Fill in a set as it happens. Idempotent: resending is safe.
logPage.patch("/:publicId/sets/:setId", async (c) => {
  const session = await sessionByPublicId(c.req.param("publicId"));
  const setId = requireIdParam(c.req.param("setId"), "set");
  const existing = await setInSession(setId, session.id);

  const body = await readJson(c, [
    "weight_kg",
    "reps",
    "distance_m",
    "duration_s",
    "effort",
    "notes",
  ]);
  const fields: Record<string, unknown> = {};
  if ("weight_kg" in body) {
    fields.weight_kg = optionalNumber(body, "weight_kg", { min: 0 });
  }
  if ("reps" in body) fields.reps = optionalInt(body, "reps", { min: 1 });
  if ("distance_m" in body) {
    fields.distance_m = optionalNumber(body, "distance_m", { min: 0 });
  }
  if ("duration_s" in body) {
    fields.duration_s = optionalNumber(body, "duration_s", { min: 0 });
  }
  if ("effort" in body) {
    fields.effort = body.effort === null ? null : requireOneOf(
      body,
      "effort",
      ["easy", "hard", "failure"] as const,
    );
  }
  if ("notes" in body) fields.notes = optionalString(body, "notes");
  if (Object.keys(fields).length === 0) {
    throw new ApiError(422, "Nothing to save.");
  }
  const pick = <T>(field: string, was: T) =>
    field in fields ? fields[field] as T : was;
  assertSetMeasures(existing.measure, existing.exercise, "actual", {
    weightKg: pick("weight_kg", existing.weight_kg),
    reps: pick("reps", existing.reps),
    distanceM: pick("distance_m", existing.distance_m),
    durationS: pick("duration_s", existing.duration_s),
  });
  assertEffort(
    existing.stimulus_type,
    existing.exercise,
    existing.kind,
    pick("reps", existing.reps),
    pick("effort", existing.effort),
  );

  const measured = fields.reps != null || fields.distance_m != null ||
    fields.duration_s != null;
  if (
    fields.performed_at === undefined && existing.performed_at === null &&
    measured
  ) {
    fields.performed_at = new Date().toISOString();
  }

  const [row] = await sql`
    update sets set ${sql(fields)} where id = ${setId}
    returning id, weight_kg::float8, reps, distance_m::float8,
      duration_s::float8, effort, performed_at, notes`;
  // The first logged set starts the session clock.
  if (session.started_at === null && measured) {
    await sql`
      update sessions set started_at = coalesce(started_at, now())
      where id = ${session.id}`;
  }
  return c.json({ set: row });
});

// An unplanned set. The page supplies the position, so a retried post lands
// on the unique (session_id, position) and returns the row instead of
// duplicating it.
logPage.post("/:publicId/sets", async (c) => {
  const session = await sessionByPublicId(c.req.param("publicId"));
  const body = await readJson(c, [
    "exercise_id",
    "position",
    "kind",
    "weight_kg",
    "reps",
    "distance_m",
    "duration_s",
    "effort",
  ]);
  const exerciseId = requireInt(body as Body, "exercise_id", { min: 1 });
  const position = requireInt(body as Body, "position", { min: 1 });
  const kind = requireOneOf(
    body,
    "kind",
    ["warmup", "working"] as const,
    "working",
  );
  const actual = {
    weightKg: optionalNumber(body, "weight_kg", { min: 0 }),
    reps: optionalInt(body, "reps", { min: 1 }),
    distanceM: optionalNumber(body, "distance_m", { min: 0 }),
    durationS: optionalNumber(body, "duration_s", { min: 0 }),
  };
  const effort = body.effort === undefined || body.effort === null
    ? null
    : requireOneOf(body, "effort", ["easy", "hard", "failure"] as const);

  const [exercise] = await sql`
    select name, measure, stimulus_type from exercises where id = ${exerciseId}`;
  if (!exercise) {
    throw new ApiError(404, "That exercise is not in the catalogue.");
  }
  assertSetMeasures(exercise.measure, exercise.name, "actual", actual);
  assertEffort(
    exercise.stimulus_type,
    exercise.name,
    kind,
    actual.reps,
    effort,
  );

  // The page never says which plan the work serves — it does not know plans
  // exist. The exercise decides it, exactly as it does in chat.
  const mesocycleId = await resolveSetMesocycleId(exerciseId, undefined);
  const measured = actual.reps !== null || actual.distanceM !== null ||
    actual.durationS !== null;

  const [row] = await sql`
    insert into sets
      (session_id, exercise_id, mesocycle_id, position, kind, weight_kg, reps,
       distance_m, duration_s, effort, performed_at)
    values
      (${session.id}, ${exerciseId}, ${mesocycleId}, ${position}, ${kind},
       ${actual.weightKg}, ${actual.reps}, ${actual.distanceM},
       ${actual.durationS}, ${effort},
       ${measured ? new Date().toISOString() : null})
    on conflict (session_id, position) do update
      set weight_kg = excluded.weight_kg, reps = excluded.reps,
        distance_m = excluded.distance_m, duration_s = excluded.duration_s,
        effort = excluded.effort,
        performed_at = coalesce(sets.performed_at, excluded.performed_at)
    returning id, position`;
  return c.json({ set: row }, 201);
});

// Notes save as they are typed, without finishing anything.
logPage.post("/:publicId/notes", async (c) => {
  const session = await sessionByPublicId(c.req.param("publicId"));
  const body = await readJson(c, ["notes"]);
  await sql`
    update sessions set notes = ${optionalString(body, "notes")}
    where id = ${session.id}`;
  return c.json({ ok: true });
});

// Finishing a workout is a field changing.
logPage.post("/:publicId/finish", async (c) => {
  const session = await sessionByPublicId(c.req.param("publicId"));
  const body = await readJson(c, ["overall_feel"]);
  const overallFeel = "overall_feel" in body
    ? optionalString(body, "overall_feel")
    : null;
  await sql`
    update sessions
    set completed_at = coalesce(completed_at, now()),
      overall_feel = coalesce(${overallFeel}, overall_feel)
    where id = ${session.id}`;
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
}

function renderPage(
  // deno-lint-ignore no-explicit-any
  session: any,
  // deno-lint-ignore no-explicit-any
  sets: any[],
  // deno-lint-ignore no-explicit-any
  lastTime: any[],
  // deno-lint-ignore no-explicit-any
  catalogue: any[],
): string {
  const data = JSON.stringify({
    publicId: session.public_id,
    date: session.date,
    completed: session.completed_at !== null,
    notes: session.notes,
    overallFeel: session.overall_feel,
    sets,
    lastTime: Object.fromEntries(
      lastTime.map((l) => [l.exercise_id, { date: l.date, sets: l.sets }]),
    ),
    catalogue,
  }).replace(/</g, "\\u003c");

  const dateLabel = new Date(`${session.date}T12:00:00Z`).toLocaleDateString(
    "en-GB",
    { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" },
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="theme-color" content="#16181d">
<title>Session — ${esc(dateLabel)}</title>
<style>
  :root {
    --iron: #16181d; --steel: #1f232b; --seam: #2c313b;
    --chalk: #edeef0; --dust: #8a8f98;
    --plate-easy: #4caf6e; --plate-hard: #e3b341; --plate-fail: #d64545;
    font-size: 17px;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--iron); color: var(--chalk);
    font-family: ui-rounded, -apple-system, system-ui, sans-serif;
    padding-bottom: 6rem;
  }
  .num { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }

  header {
    position: sticky; top: 0; z-index: 3;
    display: flex; align-items: baseline; gap: .6rem;
    padding: .8rem 1rem; background: var(--iron);
    border-bottom: 1px solid var(--seam);
  }
  header h1 { font-size: 1rem; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
  header .progress { margin-left: auto; color: var(--dust); font-size: .85rem; }
  #sync { width: .5rem; height: .5rem; border-radius: 50%; background: var(--plate-easy); align-self: center; }
  #sync.queued { background: var(--plate-hard); }

  .exercise { margin: 1rem; padding: 1rem; background: var(--steel); border-radius: .8rem; }
  .exercise h2 { font-size: 1.05rem; font-weight: 800; }
  .exercise .range { color: var(--dust); font-weight: 600; font-size: .85rem; margin-left: .4rem; }
  .last { color: var(--dust); font-size: .85rem; margin-top: .25rem; }

  .set { border-top: 1px solid var(--seam); margin-top: .8rem; padding-top: .8rem; }
  .set-line { display: flex; align-items: center; gap: .5rem; }
  .pos { color: var(--dust); font-size: .8rem; width: 1.1rem; }
  .warmup-tag { color: var(--dust); font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; }
  .target {
    color: var(--dust); font-size: .95rem; background: none; border: none;
    padding: .4rem .5rem .4rem 0; cursor: pointer; font-family: inherit;
  }
  .target:active { color: var(--chalk); }
  input.w, input.r, input.d, input.t {
    width: 4.2rem; padding: .55rem .4rem; text-align: center;
    font-size: 1.15rem; font-weight: 700; color: var(--chalk);
    background: var(--iron); border: 1px solid var(--seam); border-radius: .5rem;
  }
  input.r { width: 4rem; }
  input.d, input.t { width: 5.2rem; }
  .times { color: var(--dust); }
  input:focus-visible, button:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--chalk); outline-offset: 2px;
  }

  .chips { display: flex; gap: .6rem; margin-top: .6rem; padding-left: 1.6rem; }
  .chip {
    width: 3.2rem; height: 3.2rem; border-radius: 50%;
    border: 2px solid var(--seam); background: none; color: var(--dust);
    font-size: .8rem; font-weight: 700; font-family: inherit; cursor: pointer;
  }
  .chip[data-effort="easy"].on { border-color: var(--plate-easy); background: var(--plate-easy); color: var(--iron); }
  .chip[data-effort="hard"].on { border-color: var(--plate-hard); background: var(--plate-hard); color: var(--iron); }
  .chip[data-effort="failure"].on { border-color: var(--plate-fail); background: var(--plate-fail); color: var(--iron); }
  @media (prefers-reduced-motion: no-preference) {
    .set.saved { animation: settle .5s ease-out; }
    @keyframes settle { from { background: rgba(76,175,110,.12); } to { background: none; } }
  }

  .row-actions { margin-top: .8rem; }
  .ghost {
    background: none; border: 1px dashed var(--seam); color: var(--dust);
    padding: .5rem .9rem; border-radius: .5rem; font-family: inherit; font-size: .9rem; cursor: pointer;
  }
  .exnotes { width: 100%; margin-top: .8rem; background: var(--iron); color: var(--chalk);
    border: 1px solid var(--seam); border-radius: .5rem; padding: .5rem; font-family: inherit; font-size: .9rem; }

  .add-exercise { margin: 1rem; display: flex; gap: .6rem; }
  .add-exercise select { flex: 1; padding: .6rem; background: var(--steel); color: var(--chalk);
    border: 1px solid var(--seam); border-radius: .5rem; font-family: inherit; }

  .finish { margin: 1.5rem 1rem; }
  .finish textarea { width: 100%; }
  .feel { display: flex; gap: .6rem; margin: .8rem 0; }
  .feel button { flex: 1; padding: .7rem 0; border-radius: .5rem; border: 1px solid var(--seam);
    background: var(--steel); color: var(--dust); font-family: inherit; font-weight: 700; cursor: pointer; }
  .feel button.on { color: var(--iron); background: var(--chalk); border-color: var(--chalk); }
  #finishBtn {
    width: 100%; padding: 1rem; font-size: 1.05rem; font-weight: 800;
    border: none; border-radius: .8rem; background: var(--chalk); color: var(--iron);
    font-family: inherit; cursor: pointer;
  }
  #finishBtn:disabled { opacity: .5; }
  .done-note { text-align: center; color: var(--plate-easy); font-weight: 700; margin-top: .8rem; }
</style>
</head>
<body>
<header>
  <h1>${esc(dateLabel)}</h1>
  <span class="progress num" id="progress"></span>
  <span id="sync" title="sync status"></span>
</header>
<main id="app"></main>
<script>
const DATA = ${data};
const $ = (s, el) => (el || document).querySelector(s);
const api = (path, body, method) =>
  fetch(location.pathname.replace(/\\/+$/, "") + path, {
    method: method || "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });

// --- offline queue: every write goes through here; localStorage holds the
// unsent tail, resent in order whenever we are back online.
const QKEY = "q-" + DATA.publicId;
const queue = JSON.parse(localStorage.getItem(QKEY) || "[]");
let flushing = false;
function enqueue(job) {
  const i = queue.findIndex((j) => j.key && j.key === job.key);
  if (i >= 0) queue[i] = job; else queue.push(job);
  localStorage.setItem(QKEY, JSON.stringify(queue));
  updateSync(); flush();
}
async function flush() {
  if (flushing) return; flushing = true;
  while (queue.length) {
    const job = queue[0];
    try { await api(job.path, job.body, job.method); }
    catch { break; }
    // Remove *this* job, not whatever is at the head now. An edit made while
    // the request was in flight replaced it under us, and a blind shift()
    // would drop that edit unsent — the set would read back as the older
    // numbers with an empty queue and no error, which is the one failure this
    // queue exists to prevent. If it was replaced, indexOf finds nothing, the
    // replacement stays queued, and the next pass sends it.
    const at = queue.indexOf(job);
    if (at >= 0) queue.splice(at, 1);
    localStorage.setItem(QKEY, JSON.stringify(queue));
  }
  flushing = false; updateSync();
}
function updateSync() {
  $("#sync").className = queue.length ? "queued" : "";
  $("#sync").title = queue.length ? queue.length + " to send" : "synced";
}
addEventListener("online", flush);
setInterval(flush, 15000);

// --- render ---
const app = $("#app");
const byExercise = [];
for (const s of DATA.sets) {
  const last = byExercise[byExercise.length - 1];
  if (last && last.exercise_id === s.exercise_id) last.sets.push(s);
  else byExercise.push({ exercise_id: s.exercise_id, name: s.exercise, measure: s.measure, plan_notes: s.plan_notes, sets: [s] });
}
let maxPosition = Math.max(0, ...DATA.sets.map((s) => s.position));

// What a set of an exercise records. Mirrors the server's rules, so the page
// asks for exactly the fields the API will accept and no others — a sprint
// gets metres and a stopwatch, never an empty kg box it would reject.
const MEASURES = {
  load_reps: { fields: [["weight_kg","w","kg","decimal"],["reps","r","reps","numeric"]], mode: "all", chips: true, sep: "\\u00d7" },
  reps: { fields: [["reps","r","reps","numeric"]], mode: "all", chips: true, sep: "" },
  distance: { fields: [["distance_m","d","m","decimal"]], mode: "all", chips: false, sep: "" },
  duration: { fields: [["duration_s","t","time","text"]], mode: "all", chips: false, sep: "" },
  distance_duration: { fields: [["distance_m","d","m","decimal"],["duration_s","t","time","text"]], mode: "any", chips: false, sep: "in" },
};
const spec = (m) => MEASURES[m] || MEASURES.load_reps;
const isTime = (key) => key === "duration_s";

// Times are typed the way they are said: "5.21" for a sprint, "28:30" for a
// run, "1:12:00" for a long one. Seconds are what the column holds.
function parseTime(v) {
  v = String(v).trim();
  if (v === "") return null;
  let total = 0;
  for (const part of v.split(":")) {
    const n = Number(part);
    if (part === "" || !isFinite(n)) return null;
    total = total * 60 + n;
  }
  return total;
}
function fmtTime(s) {
  if (s === null || s === undefined) return "";
  if (s < 60) return String(s);
  const m = Math.floor(s / 60), r = Math.round((s - m * 60) * 100) / 100;
  return m + ":" + (r < 10 ? "0" : "") + r;
}
function num(v) { return v % 1 ? String(Number(v.toFixed(2))) : String(v); }
function readField(el, key) { return isTime(key) ? parseTime(el.value) : (el.value === "" ? null : Number(el.value)); }
function writeField(el, key, v) { el.value = v === null || v === undefined ? "" : (isTime(key) ? fmtTime(v) : v); }

// One set as a line of text: the target chip, and the "last ·" history.
function fmtSet(measure, v, prefix) {
  const parts = spec(measure).fields
    .map(function (f) { const raw = v[prefix + f[0]]; return raw === null || raw === undefined ? null : (isTime(f[0]) ? fmtTime(raw) : num(raw) + (f[2] === "m" ? " m" : "")); })
    .filter(function (x) { return x !== null; });
  if (!parts.length) return "";
  const sep = spec(measure).sep;
  const glue = sep === "\\u00d7" ? "\\u2009\\u00d7\\u2009" : (sep ? " " + sep + " " : " ");
  return parts.join(glue) + (measure === "reps" ? " reps" : "");
}

function setRow(s) {
  const div = document.createElement("div");
  div.className = "set"; div.dataset.id = s.id;
  const isWork = s.kind === "working";
  const sp = spec(s.measure);
  const targetText = fmtSet(s.measure, s, "target_");
  const inputs = sp.fields.map(function (f, i) {
    const key = f[0], cls = f[1], ph = f[2], mode = f[3];
    const shown = isTime(key) ? fmtTime(s[key]) : (s[key] === null || s[key] === undefined ? "" : s[key]);
    return (i && sp.sep ? '<span class="times">' + sp.sep + "</span>" : "") +
      '<input class="' + cls + ' num" inputmode="' + mode + '" placeholder="' + ph + '" value="' + shown + '">';
  }).join("");
  div.innerHTML =
    '<div class="set-line">' +
    '<span class="pos num">' + s.position + "</span>" +
    (isWork ? "" : '<span class="warmup-tag">warmup</span>') +
    (targetText
      ? '<button class="target num" title="use target">' + targetText + "</button>"
      : "") +
    inputs +
    "</div>" +
    (isWork && sp.chips
      ? '<div class="chips">' +
        ["easy", "hard", "failure"].map((e) =>
          '<button class="chip' + (s.effort === e ? " on" : "") + '" data-effort="' + e + '">' +
          (e === "failure" ? "fail" : e) + "</button>"
        ).join("") + "</div>"
      : "");
  const boxes = sp.fields.map((f) => [f[0], $("." + f[1], div)]);
  // The body the API expects for this measure: every field it records, null
  // when blank, so clearing one is a correction rather than a no-op.
  div.readBody = () => {
    const body = {};
    for (const [key, el] of boxes) body[key] = readField(el, key);
    const filled = boxes.filter(([key, el]) => readField(el, key) !== null).length;
    const enough = sp.mode === "all" ? filled === boxes.length : filled > 0;
    if (!enough) return null;
    if (isWork && sp.chips) {
      const effort = $(".chip.on", div)?.dataset.effort ?? null;
      if (!effort) return null; // chips are required; wait for the tap
      body.effort = effort;
    }
    return body;
  };
  const save = () => {
    if (s.id === null) return; // unplanned rows have their own sender
    const body = div.readBody();
    if (!body) return;
    enqueue({ key: "set-" + s.id, path: "/sets/" + s.id, body });
    div.classList.remove("saved"); void div.offsetWidth; div.classList.add("saved");
    updateProgress();
  };
  const tgt = $(".target", div);
  if (tgt) tgt.addEventListener("click", () => {
    for (const [key, el] of boxes) writeField(el, key, s["target_" + key]);
    save(); boxes[0][1].focus();
  });
  boxes.forEach(([, el]) => el.addEventListener("change", save));
  div.querySelectorAll(".chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      div.querySelectorAll(".chip").forEach((x) => x.classList.remove("on"));
      chip.classList.add("on"); save();
    }));
  return div;
}

function exerciseCard(group) {
  const card = document.createElement("section");
  card.className = "exercise";
  const last = DATA.lastTime[group.exercise_id];
  card.innerHTML =
    "<h2>" + group.name + "</h2>" +
    (last && last.sets
      ? '<div class="last num">last \\u00b7 ' +
        last.sets.map((x) => fmtSet(group.measure, x, "")).join(" \\u00b7 ") + "</div>"
      : '<div class="last">first time \\u2014 no history</div>');
  for (const s of group.sets) card.appendChild(setRow(s));
  const actions = document.createElement("div");
  actions.className = "row-actions";
  const addBtn = document.createElement("button");
  addBtn.className = "ghost"; addBtn.textContent = "+ set";
  addBtn.addEventListener("click", () => {
    maxPosition += 1;
    const s = { id: null, exercise_id: group.exercise_id, measure: group.measure,
      position: maxPosition, kind: "working",
      target_weight_kg: null, target_reps: null,
      target_distance_m: null, target_duration_s: null,
      weight_kg: null, reps: null, distance_m: null, duration_s: null,
      effort: null, clientPos: maxPosition };
    const row = unplannedRow(s, group.name);
    card.insertBefore(row, actions);
  });
  actions.appendChild(addBtn);
  card.appendChild(actions);
  const notes = document.createElement("textarea");
  notes.className = "exnotes"; notes.rows = 1;
  notes.placeholder = "notes \\u2014 " + group.name.toLowerCase();
  notes.addEventListener("change", saveNotes);
  notes.dataset.exercise = group.name;
  card.appendChild(notes);
  return card;
}

// An unplanned set posts once its numbers are in; the client-chosen position
// makes the post safe to retry.
function unplannedRow(s, _name) {
  const div = setRow(s);
  const post = () => {
    const body = div.readBody();
    if (!body) return;
    body.exercise_id = s.exercise_id; body.position = s.clientPos; body.kind = "working";
    enqueue({ key: "new-" + s.clientPos, path: "/sets", method: "POST", body });
    div.classList.remove("saved"); void div.offsetWidth; div.classList.add("saved");
    updateProgress();
  };
  div.querySelectorAll("input").forEach((el) => { el.removeEventListener("change", post); el.addEventListener("change", post); });
  div.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", post));
  return div;
}

function saveNotes() {
  const parts = [];
  document.querySelectorAll(".exnotes").forEach((t) => {
    if (t === $("#sessionNotes")) return;
    if (t.value.trim()) parts.push(t.dataset.exercise + ": " + t.value.trim());
  });
  const bottom = $("#sessionNotes");
  if (bottom && bottom.value.trim()) parts.push(bottom.value.trim());
  enqueue({ key: "notes", path: "/notes", method: "POST",
    body: { notes: parts.length ? parts.join("\\n") : null } });
}

function updateProgress() {
  const rows = [...document.querySelectorAll('.set')];
  const working = rows.filter((d) => !$(".warmup-tag", d));
  const done = working.filter((d) => d.readBody && d.readBody() !== null);
  $("#progress").textContent = done.length + "/" + working.length + " sets";
}

for (const group of byExercise) app.appendChild(exerciseCard(group));

// add an exercise from the catalogue — the page never creates one
const addWrap = document.createElement("div");
addWrap.className = "add-exercise";
addWrap.innerHTML = '<select><option value="">add exercise\\u2026</option>' +
  DATA.catalogue.map((e) => '<option value="' + e.id + '">' + e.name + "</option>").join("") +
  "</select>";
$("select", addWrap).addEventListener("change", (ev) => {
  const id = Number(ev.target.value);
  if (!id) return;
  const entry = DATA.catalogue.find((e) => e.id === id);
  const group = { exercise_id: id, name: entry.name, measure: entry.measure, plan_notes: null, sets: [] };
  const card = exerciseCard(group);
  app.insertBefore(card, addWrap);
  $(".ghost", card).click();
  ev.target.value = "";
});
app.appendChild(addWrap);

// finish
const finish = document.createElement("div");
finish.className = "finish";
finish.innerHTML =
  '<textarea id="sessionNotes" class="exnotes" rows="2" placeholder="session notes"></textarea>' +
  '<div class="feel">' +
  ["rough", "ok", "solid", "great"].map((f) => '<button data-feel="' + f + '">' + f + "</button>").join("") +
  "</div>" +
  '<button id="finishBtn">Finish session</button>' +
  (DATA.completed ? '<div class="done-note">Session finished</div>' : "");
$("#sessionNotes", finish).addEventListener("change", saveNotes);
finish.querySelectorAll(".feel button").forEach((b) =>
  b.addEventListener("click", () => {
    finish.querySelectorAll(".feel button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
  }));
$("#finishBtn", finish).addEventListener("click", () => {
  const feel = $(".feel .on", finish)?.dataset.feel ?? null;
  saveNotes();
  enqueue({ key: "finish", path: "/finish", method: "POST", body: { overall_feel: feel } });
  $("#finishBtn").disabled = true;
  $("#finishBtn").textContent = "Finished";
});
if (DATA.completed) { $("#finishBtn", finish).disabled = true; $("#finishBtn", finish).textContent = "Finished"; }
if (DATA.overallFeel) {
  const b = finish.querySelector('[data-feel="' + DATA.overallFeel + '"]');
  if (b) b.classList.add("on");
}
app.appendChild(finish);

updateProgress(); updateSync(); flush();
</script>
</body>
</html>`;
}
