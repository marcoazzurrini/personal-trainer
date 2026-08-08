// The log page namespace: /s/:public_id. Not part of the coach API — the
// page is server-rendered here, its posts land on sub-routes of the same
// path, and the handlers write to Postgres directly. Tokenless: the
// unguessable public_id is this namespace's auth. No coaching logic lives
// here; the page renders what it is given and posts back what was typed.

import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import {
  type Body,
  optionalInt,
  optionalNumber,
  optionalString,
  readJson,
  requireIdParam,
  requireInt,
  requireOneOf,
} from "../lib/validate.ts";

export const logPage = new Hono();

// deno-lint-ignore no-explicit-any
async function sessionByPublicId(publicId: string): Promise<any> {
  const [session] = await sql`
    select id, public_id, date, rationale, notes, overall_feel,
      started_at, completed_at, mesocycle_id
    from sessions where public_id = ${publicId}`;
  if (!session) {
    throw new ApiError(404, "No session here. Check the link.");
  }
  return session;
}

// A set may only be written through the session link it belongs to.
async function setInSession(setId: number, sessionId: number) {
  const [row] = await sql`
    select id, kind, performed_at from sets
    where id = ${setId} and session_id = ${sessionId}`;
  if (!row) throw new ApiError(404, "That set is not part of this session.");
  return row;
}

logPage.get("/:publicId", async (c) => {
  const session = await sessionByPublicId(c.req.param("publicId"));

  const sets = await sql`
    select t.id, t.exercise_id, e.name as exercise, t.position, t.kind,
      t.target_weight_kg::float8, t.target_reps,
      t.weight_kg::float8, t.reps, t.effort, t.notes,
      me.notes as plan_notes
    from sets t
    join exercises e on e.id = t.exercise_id
    left join mesocycle_exercises me
      on me.mesocycle_id = ${session.mesocycle_id}
      and me.exercise_id = t.exercise_id
    where t.session_id = ${session.id}
    order by t.position`;

  // Last time's numbers per exercise: the working sets of the most recent
  // earlier session that performed it.
  const exerciseIds = [...new Set(sets.map((s) => s.exercise_id))];
  const lastTime = exerciseIds.length === 0 ? [] : await sql`
    select x.exercise_id, prev.date,
      (select json_agg(json_build_object(
          'weight_kg', p.weight_kg::float8, 'reps', p.reps, 'effort', p.effort)
        order by p.position)
       from sets p
       where p.session_id = prev.id and p.exercise_id = x.exercise_id
         and p.kind = 'working' and p.reps is not null) as sets
    from unnest(${sql.array(exerciseIds)}::bigint[]) as x(exercise_id)
    cross join lateral (
      select s2.id, s2.date
      from sessions s2
      join sets t2 on t2.session_id = s2.id
      where t2.exercise_id = x.exercise_id and t2.kind = 'working'
        and t2.reps is not null and s2.id <> ${session.id}
        and s2.date <= ${session.date}
      order by s2.date desc, s2.id desc
      limit 1
    ) prev`;

  const catalogue = await sql`
    select id, name from exercises order by name`;

  return c.html(renderPage(session, sets, lastTime, catalogue));
});

// Fill in a set as it happens. Idempotent: resending is safe.
logPage.patch("/:publicId/sets/:setId", async (c) => {
  const session = await sessionByPublicId(c.req.param("publicId"));
  const setId = requireIdParam(c.req.param("setId"), "set");
  const existing = await setInSession(setId, session.id);

  const body = await readJson(c);
  const fields: Record<string, unknown> = {};
  if ("weight_kg" in body) {
    fields.weight_kg = optionalNumber(body, "weight_kg", { min: 0 });
  }
  if ("reps" in body) fields.reps = optionalInt(body, "reps", { min: 1 });
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
  if (
    fields.performed_at === undefined && existing.performed_at === null &&
    (fields.weight_kg != null || fields.reps != null)
  ) {
    fields.performed_at = new Date().toISOString();
  }

  const [row] = await sql`
    update sets set ${sql(fields)} where id = ${setId}
    returning id, weight_kg::float8, reps, effort, performed_at, notes`;
  // The first logged set starts the session clock.
  if (session.started_at === null && (fields.weight_kg != null)) {
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
  const body = await readJson(c);
  const exerciseId = requireInt(body as Body, "exercise_id", { min: 1 });
  const position = requireInt(body as Body, "position", { min: 1 });
  const kind = requireOneOf(
    body,
    "kind",
    ["warmup", "working"] as const,
    "working",
  );
  const weightKg = optionalNumber(body, "weight_kg", { min: 0 });
  const reps = optionalInt(body, "reps", { min: 1 });
  const effort = body.effort === undefined || body.effort === null
    ? null
    : requireOneOf(body, "effort", ["easy", "hard", "failure"] as const);

  const [row] = await sql`
    insert into sets
      (session_id, exercise_id, position, kind, weight_kg, reps, effort,
       performed_at)
    values
      (${session.id}, ${exerciseId}, ${position}, ${kind}, ${weightKg},
       ${reps}, ${effort},
       ${weightKg === null ? null : new Date().toISOString()})
    on conflict (session_id, position) do update
      set weight_kg = excluded.weight_kg, reps = excluded.reps,
        effort = excluded.effort,
        performed_at = coalesce(sets.performed_at, excluded.performed_at)
    returning id, position`;
  return c.json({ set: row }, 201);
});

// Notes save as they are typed, without finishing anything.
logPage.post("/:publicId/notes", async (c) => {
  const session = await sessionByPublicId(c.req.param("publicId"));
  const body = await readJson(c);
  await sql`
    update sessions set notes = ${optionalString(body, "notes")}
    where id = ${session.id}`;
  return c.json({ ok: true });
});

// Finishing a workout is a field changing.
logPage.post("/:publicId/finish", async (c) => {
  const session = await sessionByPublicId(c.req.param("publicId"));
  const body = await readJson(c);
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
  input.w, input.r {
    width: 4.2rem; padding: .55rem .4rem; text-align: center;
    font-size: 1.15rem; font-weight: 700; color: var(--chalk);
    background: var(--iron); border: 1px solid var(--seam); border-radius: .5rem;
  }
  input.r { width: 4rem; }
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
    queue.shift(); localStorage.setItem(QKEY, JSON.stringify(queue));
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
  else byExercise.push({ exercise_id: s.exercise_id, name: s.exercise, plan_notes: s.plan_notes, sets: [s] });
}
let maxPosition = Math.max(0, ...DATA.sets.map((s) => s.position));

function fmt(w, r) { return (w % 1 ? w.toFixed(1) : w) + "\\u2009\\u00d7\\u2009" + r; }

function setRow(s) {
  const div = document.createElement("div");
  div.className = "set"; div.dataset.id = s.id;
  const isWork = s.kind === "working";
  div.innerHTML =
    '<div class="set-line">' +
    '<span class="pos num">' + s.position + "</span>" +
    (isWork ? "" : '<span class="warmup-tag">warmup</span>') +
    (s.target_reps !== null
      ? '<button class="target num" title="use target">' + fmt(s.target_weight_kg, s.target_reps) + "</button>"
      : "") +
    '<input class="w num" inputmode="decimal" placeholder="kg" value="' + (s.weight_kg ?? "") + '">' +
    '<span class="times">\\u00d7</span>' +
    '<input class="r num" inputmode="numeric" placeholder="reps" value="' + (s.reps ?? "") + '">' +
    "</div>" +
    (isWork
      ? '<div class="chips">' +
        ["easy", "hard", "failure"].map((e) =>
          '<button class="chip' + (s.effort === e ? " on" : "") + '" data-effort="' + e + '">' +
          (e === "failure" ? "fail" : e) + "</button>"
        ).join("") + "</div>"
      : "");
  const w = $(".w", div), r = $(".r", div);
  const save = () => {
    if (s.id === null) return; // unplanned rows have their own sender
    const weight = w.value === "" ? null : Number(w.value);
    const reps = r.value === "" ? null : Number(r.value);
    const effort = $(".chip.on", div)?.dataset.effort ?? null;
    if (weight === null || reps === null) return;
    if (isWork && !effort) return; // chips are required; wait for the tap
    enqueue({ key: "set-" + s.id, path: "/sets/" + s.id, body: { weight_kg: weight, reps, effort } });
    div.classList.remove("saved"); void div.offsetWidth; div.classList.add("saved");
    updateProgress();
  };
  const tgt = $(".target", div);
  if (tgt) tgt.addEventListener("click", () => {
    w.value = s.target_weight_kg; r.value = s.target_reps; save(); w.focus();
  });
  [w, r].forEach((el) => el.addEventListener("change", save));
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
    "<h2>" + group.name +
    (group.rep_low !== null && group.rep_low !== undefined && group.rep_low !== null
      ? '<span class="range num">' + group.rep_low + "\\u2013" + group.rep_high + " reps</span>" : "") +
    "</h2>" +
    (last && last.sets
      ? '<div class="last num">last \\u00b7 ' +
        last.sets.map((x) => fmt(x.weight_kg, x.reps)).join(" \\u00b7 ") + "</div>"
      : '<div class="last">first time \\u2014 no history</div>');
  for (const s of group.sets) card.appendChild(setRow(s));
  const actions = document.createElement("div");
  actions.className = "row-actions";
  const addBtn = document.createElement("button");
  addBtn.className = "ghost"; addBtn.textContent = "+ set";
  addBtn.addEventListener("click", () => {
    maxPosition += 1;
    const s = { id: null, exercise_id: group.exercise_id, position: maxPosition,
      kind: "working", target_weight_kg: null, target_reps: null,
      weight_kg: null, reps: null, effort: null, clientPos: maxPosition };
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
  const w = $(".w", div), r = $(".r", div);
  const post = () => {
    const weight = w.value === "" ? null : Number(w.value);
    const reps = r.value === "" ? null : Number(r.value);
    const effort = $(".chip.on", div)?.dataset.effort ?? null;
    if (weight === null || reps === null || !effort) return;
    enqueue({ key: "new-" + s.clientPos, path: "/sets", method: "POST",
      body: { exercise_id: s.exercise_id, position: s.clientPos, kind: "working",
        weight_kg: weight, reps, effort } });
    div.classList.remove("saved"); void div.offsetWidth; div.classList.add("saved");
    updateProgress();
  };
  [w, r].forEach((el) => { el.removeEventListener("change", post); el.addEventListener("change", post); });
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
  const working = rows.filter((d) => $(".chips", d));
  const done = working.filter((d) => $(".w", d).value !== "" && $(".r", d).value !== "" && $(".chip.on", d));
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
  const name = DATA.catalogue.find((e) => e.id === id).name;
  const group = { exercise_id: id, name, plan_notes: null, sets: [] };
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
