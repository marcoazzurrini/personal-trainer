import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import {
  api,
  daysBefore,
  DB_URL,
  lastFinishedSunday,
  resetNutrition,
  seedCut,
  seedWeighIns,
  today,
  uuid,
} from "./helpers.ts";

type Goal = "cut" | "maintain" | "gain";

async function saveTarget(goal: Goal, day: string) {
  const result = await api.post("/nutrition-targets", {
    goal,
    effective_from: day,
    rate_pct_bw_week: goal === "cut" ? -0.5 : goal === "gain" ? 0.25 : 0,
    kcal_target: 2200,
    protein_g_target: 180,
    decision: `Synthetic ${goal} plan effective ${day}.`,
  });
  assertEquals(result.status, 201, result.body.error);
  return result.body;
}

async function switches() {
  return (await api.get("/nutrition-events")).body.events as Array<{
    id: number;
    day: string;
    kind: string;
    note: string | null;
    created_at: string;
  }>;
}

Deno.test("switches follow effective dates, not target insertion order", async () => {
  await resetNutrition();
  const end = lastFinishedSunday();
  await seedWeighIns([end], 80);
  const early = daysBefore(end, 20);
  const middle = daysBefore(end, 10);
  const first = await saveTarget("cut", early);
  assertEquals(first.phase_switch_registered, false);
  const latest = await saveTarget("maintain", end);
  assertEquals(latest.phase_switch_registered, true);
  assertEquals((await switches()).map((e) => [e.id, e.day, e.note]), [
    [-latest.target.id, end, "cut -> maintain"],
  ]);

  // Inserting a same-goal predecessor removes the old later switch.
  const backdated = await saveTarget("maintain", middle);
  assertEquals(backdated.phase_switch_registered, true);
  assertEquals((await switches()).map((e) => [e.id, e.day, e.note]), [
    [-backdated.target.id, middle, "cut -> maintain"],
  ]);
  assertEquals(
    (await api.delete(`/nutrition-events/${-latest.target.id}`)).status,
    404,
  );

  // A different middle winner changes both adjacent transitions.
  const revised = await saveTarget("gain", middle);
  assertEquals((await switches()).map((e) => [e.id, e.day, e.note]), [
    [-latest.target.id, end, "gain -> maintain"],
    [-revised.target.id, middle, "cut -> gain"],
  ]);
  assertEquals(
    (await api.delete(`/nutrition-events/${-backdated.target.id}`)).status,
    404,
  );

  const continued = await saveTarget("maintain", daysBefore(end, -1));
  assertEquals(continued.phase_switch_registered, false);
  assertEquals((await switches()).length, 2);

  // Backdating before the first saved date creates a switch at that old first
  // target, not on the new earliest target.
  const earliest = await saveTarget("gain", daysBefore(early, 1));
  assertEquals(earliest.phase_switch_registered, false);
  assertEquals((await switches()).map((e) => [e.id, e.note]), [
    [-latest.target.id, "gain -> maintain"],
    [-revised.target.id, "cut -> gain"],
    [-first.target.id, "gain -> cut"],
  ]);
  assertEquals((await api.get("/nutrition-targets")).body.targets.length, 6);
});

Deno.test("same-date revisions choose one goal and never invent an intraday switch", async () => {
  await resetNutrition();
  const day = lastFinishedSunday();
  await seedWeighIns([day], 80);
  await saveTarget("cut", day);
  const firstDateRevision = await saveTarget("gain", day);
  assertEquals(firstDateRevision.phase_switch_registered, false);
  assertEquals(await switches(), []);

  const later = daysBefore(day, -1);
  const changed = await saveTarget("maintain", later);
  assertEquals(changed.phase_switch_registered, true);
  // Revising calories within the same day's phase still leaves that day's
  // switch from the prior date; it is not a second maintain-to-maintain event.
  const sameGoal = await saveTarget("maintain", later);
  assertEquals(sameGoal.phase_switch_registered, true);
  assertEquals((await switches()).map((e) => [e.id, e.note]), [
    [-sameGoal.target.id, "gain -> maintain"],
  ]);
  const undone = await saveTarget("gain", later);
  assertEquals(undone.phase_switch_registered, false);
  assertEquals(await switches(), []);
  assertEquals(
    (await api.delete(`/nutrition-events/${-changed.target.id}`)).status,
    404,
  );
});

Deno.test("automatic dismissal preserves plans and manual events remain independent", async () => {
  await resetNutrition();
  const day = today();
  await seedWeighIns([daysBefore(day, 1)], 80);
  await saveTarget("cut", daysBefore(day, 2));
  const switched = await saveTarget("maintain", day);
  const originalTargets = (await api.get("/nutrition-targets")).body.targets;
  const automatic = (await switches())[0];
  assertEquals(automatic.id, -switched.target.id);
  assertEquals(automatic.created_at, switched.target.created_at);

  const manualInput = {
    kind: "phase_switch",
    day,
    note: "cut -> maintain",
    request_id: uuid(),
  };
  const manual = await api.post("/nutrition-events", manualInput);
  assertEquals(manual.status, 201);
  assert(manual.body.event.id > 0);
  const replay = await api.post("/nutrition-events", manualInput);
  assertEquals(replay.status, 200);
  assertEquals(replay.body.event, manual.body.event);
  const other = await api.post("/nutrition-events", {
    kind: "creatine_start",
    note: "Explicit unrelated transient",
  });
  assertEquals(other.status, 201);
  assertEquals((await switches()).length, 3);

  const withdrawn = await api.delete(`/nutrition-events/${automatic.id}`);
  assertEquals(withdrawn.status, 200);
  assertEquals(withdrawn.body.deleted, {
    day,
    kind: "phase_switch",
    note: "cut -> maintain",
  });
  assertEquals(
    (await api.delete(`/nutrition-events/${automatic.id}`)).status,
    404,
  );
  assertEquals(
    (await api.get("/nutrition-targets")).body.targets,
    originalTargets,
  );
  assertEquals(
    (await switches()).map((e) => e.id).sort(),
    [
      manual.body.event.id,
      other.body.event.id,
    ].sort(),
  );

  // A backdated predecessor does not undo the explicit dismissal of this
  // target, even though the transition would now have a different note.
  await saveTarget("gain", daysBefore(day, 1));
  assert(!(await switches()).some((e) => e.id === automatic.id));
  // A new replacement target is independent and can be dismissed separately.
  const replacement = await saveTarget("maintain", day);
  assertEquals(replacement.phase_switch_registered, true);
  assert((await switches()).some((e) => e.id === -replacement.target.id));

  assertEquals(
    (await api.delete(`/nutrition-events/${manual.body.event.id}`)).status,
    200,
  );
  assertEquals(
    (await api.delete(`/nutrition-events/${manual.body.event.id}`)).status,
    404,
  );
  assert((await switches()).some((e) => e.id === -replacement.target.id));
  assert((await switches()).some((e) => e.id === other.body.event.id));
  for (const id of ["0", "-0", "-1.5", "not-an-id", "9007199254740992"]) {
    const invalid = await api.delete(`/nutrition-events/${id}`);
    assertEquals(invalid.status, 422);
    assert(invalid.body.error.includes("GET /nutrition-events"));
  }
  assertEquals((await api.delete("/nutrition-events/-999999")).status, 404);
});

Deno.test("legacy-looking recorded switches are not guessed away", async () => {
  await resetNutrition();
  const day = today();
  await seedWeighIns([daysBefore(day, 1)], 80);
  await saveTarget("cut", daysBefore(day, 1));
  const target = await saveTarget("maintain", day);
  // Historical rows permit null request_id, which is not proof of origin.
  const db = postgres(DB_URL);
  try {
    const [legacy] = await db`
      insert into nutrition_events (day, kind, note)
      values (${day}, 'phase_switch', 'cut -> maintain') returning id`;
    const events = await switches();
    assertEquals(events.length, 2);
    assert(events.some((e) => e.id === Number(legacy.id)));
    assert(events.some((e) => e.id === -target.target.id));
    assertEquals(
      (await api.delete(`/nutrition-events/${legacy.id}`)).status,
      200,
    );
    assertEquals((await switches()).map((e) => e.id), [-target.target.id]);
  } finally {
    await db.end();
  }
});

Deno.test("automatic switches reach damping, state and weeks; suppression reaches every reader", async () => {
  await resetNutrition();
  const end = lastFinishedSunday();
  await seedCut({ days: 28, kcal: 2200, startWeightKg: 80, kgPerWeek: 0 });
  await api.post("/bodyfat", { percent: 15, method: "bia", day: end });
  // A 400 kcal/week-over-week step, with stable weight: damping must cap it
  // only when a transient is visible to the expenditure reader.
  for (let back = 0; back < 7; back++) {
    const intake = await api.post("/intake", {
      day: daysBefore(end, back),
      adhoc_kcal: 1200,
      note: "Synthetic intake step for event-reader regression",
    });
    assertEquals(intake.status, 201);
  }
  const plain = (await api.get("/nutrition-state")).body.expenditure;
  assertEquals(plain.status, "ok");
  await saveTarget("cut", daysBefore(end, 30));
  const switched = await saveTarget("maintain", end);
  const id = -switched.target.id;
  const events = await api.get("/nutrition-events");
  assertEquals(events.body.active.map((e: { id: number }) => e.id), [id]);
  const state = (await api.get("/nutrition-state")).body;
  assertEquals(state.active_transients.map((e: { id: number }) => e.id), [id]);
  assertEquals(state.expenditure.status, "damped");
  assertEquals(state.expenditure.tdee_kcal, plain.tdee_kcal - 300);
  const weekly = (await api.get("/nutrition/weekly?weeks=1")).body.weeks[0];
  assertEquals(weekly.events, [{
    day: end,
    kind: "phase_switch",
    note: "cut -> maintain",
  }]);

  const deletions = await Promise.all([
    api.delete(`/nutrition-events/${id}`),
    api.delete(`/nutrition-events/${id}`),
  ]);
  assertEquals(deletions.map((r) => r.status).sort(), [200, 404]);
  assertEquals((await api.get("/nutrition-events")).body.active, []);
  const after = (await api.get("/nutrition-state")).body;
  assertEquals(after.active_transients, []);
  assertEquals(after.expenditure, plain);
  assertEquals(
    (await api.get("/nutrition/weekly?weeks=1")).body.weeks[0].events,
    [],
  );

  // Future plans remain visible but cannot damp an earlier window or today.
  const future = await saveTarget("gain", daysBefore(today(), -1));
  assertEquals((await switches()).map((e) => e.id), [-future.target.id]);
  assertEquals((await api.get("/nutrition-events")).body.active, []);
  assertEquals((await api.get("/nutrition-state")).body.expenditure, plain);

  // Expenditure uses the finished window's end, not today's active list.
  // The fourteen-day boundary is inclusive; moving it one day earlier must
  // remove damping, even while a future switch stays in the event history.
  await saveTarget("maintain", daysBefore(end, 14));
  assertEquals(
    (await api.get("/nutrition-state")).body.expenditure.status,
    "damped",
  );
  await saveTarget("maintain", daysBefore(end, 15));
  assertEquals((await api.get("/nutrition-state")).body.expenditure, plain);
});
