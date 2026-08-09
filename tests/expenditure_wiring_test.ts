import { assert, assertEquals } from "@std/assert";
import {
  api,
  expenditureWindow as windowDays,
  lastFinishedSunday,
  MIN_USABLE_DAYS,
  resetNutrition,
  seedBodyfat,
  seedFood,
  seedIntakeDays as seedIntake,
  seedWeighIns,
  uuid,
  WINDOW_DAYS,
} from "./helpers.ts";

// The back-solve through the stack, rather than as arithmetic.
//
// expenditure_test.ts already tests backSolve() hard, against hand-computed
// values, with no database anywhere near it. What it cannot test is the wiring:
// that the days the route assembles are the days the window means, that a flag
// written through the API actually removes a day from the usable count, that a
// transient registered as an event actually reaches damp(). Every one of those
// is a join or a date range that could be quietly wrong while every unit test
// stays green — and the failure mode is not an error, it is a plausible
// expenditure number built from the wrong days.
//
// So these tests seed through the public API and assert on status transitions
// at the thresholds, where being one day out is visible.

async function expenditure() {
  const { body } = await api.get("/nutrition-state");
  return body.expenditure;
}

Deno.test("the usable-day threshold is the window the route builds", async (t) => {
  await resetNutrition();
  const days = windowDays();
  await seedFood();
  await seedWeighIns(days); // every day, so only intake is ever the blocker
  await seedBodyfat();

  await t.step("one day short of the minimum still refuses", async () => {
    await seedIntake(days.slice(-(MIN_USABLE_DAYS - 1)), 2200);
    const e = await expenditure();
    assertEquals(e.status, "insufficient_data");
    assertEquals(e.tdee_kcal, null);
    assert(
      e.blockers.some((b: string) => b.includes("13 of the 21")),
      `the count belongs in the message: ${JSON.stringify(e.blockers)}`,
    );
  });

  await t.step("the day that reaches it produces an estimate", async () => {
    // The whole test is this transition. If the route assembled a window off
    // by one day, or aligned it to the wrong Sunday, this is where it shows:
    // the same data would flip status one day early or one day late, and
    // nothing else in the payload would look wrong.
    await seedIntake([days[days.length - MIN_USABLE_DAYS]], 2200);
    const e = await expenditure();
    assertEquals(e.status, "ok", e.reason);
    assert(
      e.tdee_kcal > 2200,
      "losing weight means expenditure exceeds intake",
    );
    assertEquals(e.window.usable_days, MIN_USABLE_DAYS);
    assertEquals(e.window.days, WINDOW_DAYS);
    assertEquals(e.window.to, lastFinishedSunday());
    assertEquals(e.as_of, lastFinishedSunday());
  });
});

Deno.test("a flagged day leaves the window rather than entering as zero", async (t) => {
  await resetNutrition();
  const days = windowDays();
  await seedFood();
  await seedWeighIns(days);
  await seedBodyfat();
  await seedIntake(days.slice(-MIN_USABLE_DAYS), 2200);

  let tdeeBefore = 0;

  await t.step("the estimate stands before the flag", async () => {
    const e = await expenditure();
    assertEquals(e.status, "ok", e.reason);
    assertEquals(e.window.usable_days, MIN_USABLE_DAYS);
    tdeeBefore = e.tdee_kcal;
  });

  await t.step("flagging a logged day removes it from usable", async () => {
    // The flag has to reach the back-solve as an *exclusion*. The alternative
    // failure — the day staying in at its logged value — is invisible; the
    // one this guards against is a flagged day counting as zero intake, which
    // would drag the mean by a hundred kcal and invent a deficit that was
    // never eaten. Here the count is the observable: 14 usable becomes 13,
    // which is one short, so the estimate withdraws entirely.
    const flagged = days[days.length - 1];
    const res = await api.post(`/days/${flagged}/flags`, {
      flag: "incomplete",
    });
    assertEquals(res.status, 201);

    const e = await expenditure();
    assertEquals(e.status, "insufficient_data");
    assert(
      e.blockers.some((b: string) => b.includes("13 of the 21")),
      JSON.stringify(e.blockers),
    );
    assert(
      e.blockers.some((b: string) => b.includes("not counted as zero")),
      "the message must say the day was excluded, not zeroed",
    );
  });

  await t.step("removing the flag restores the same estimate", async () => {
    await api.delete(`/days/${days[days.length - 1]}/flags/incomplete`);
    const e = await expenditure();
    assertEquals(e.status, "ok");
    assertEquals(e.tdee_kcal, tdeeBefore, "a flag changes nothing it logged");
  });
});

Deno.test("weigh-in frequency is enforced against the window's weeks", async () => {
  await resetNutrition();
  const days = windowDays();
  await seedFood();
  await seedBodyfat();
  await seedIntake(days, 2200); // logging is perfect; only weighing is thin
  // Every fourth day: 6 weigh-ins across 3 weeks, under the 3-a-week floor.
  await seedWeighIns(days.filter((_, i) => i % 4 === 0));

  const e = await expenditure();
  assertEquals(e.status, "insufficient_data");
  assert(
    e.blockers.some((b: string) => b.includes("weigh-in day")),
    JSON.stringify(e.blockers),
  );
  assert(
    !e.blockers.some((b: string) => b.includes("logged intake")),
    "logging was perfect; only the weigh-in blocker should fire",
  );
  // The refusal still says which window it judged. from/to are the dates the
  // blocker's count belongs to; without them "0 weigh-in days" beside a
  // rolling adherence count reads as the API contradicting itself.
  assertEquals(e.window.from, days[0]);
  assertEquals(e.window.to, days[days.length - 1]);
});

Deno.test("a weigh-in after the window closes is acknowledged, not denied", async () => {
  await resetNutrition();
  const days = windowDays();
  await seedFood();
  await seedBodyfat();
  await seedIntake(days, 2200);
  // No weigh-ins inside the window at all — but one right now, after the
  // last finished Sunday. This is the exact state a Withings sync produces:
  // the blocker once said "0 weigh-ins" while the scale had synced hours
  // earlier, and the coach reported the sync as broken. measured_at is left
  // to the server's clock so the instant is always today and never future.
  await api.post("/bodyweight", { value_kg: 80 });

  const e = await expenditure();
  assertEquals(e.status, "insufficient_data");
  const blocker = e.blockers.find((b: string) => b.includes("weigh-in day"));
  assert(blocker, JSON.stringify(e.blockers));
  assert(
    blocker.includes("since the window closed"),
    `the morning's weigh-in must be acknowledged: ${blocker}`,
  );
  assert(
    blocker.includes("counted when the current week finishes"),
    blocker,
  );
});

Deno.test("a registered transient damps the estimate, and only while it stands", async (t) => {
  await resetNutrition();
  // 35 days, so the window one week back is also fully covered — damping is a
  // comparison between two windows, and without the older one there is
  // nothing to compare against.
  const end = lastFinishedSunday();
  const days = windowDays(35);
  await seedFood();
  await seedWeighIns(days);
  await seedBodyfat();

  // Intake steps up sharply for the final week. The two windows overlap by 14
  // days, so a 1,500 kcal step over 7 of the 21 moves the mean by ~500 — a
  // week-over-week jump no metabolism makes, which is exactly the shape the
  // damping exists to catch.
  await seedIntake(days.slice(0, -7), 2200);
  await seedIntake(days.slice(-7), 3700);

  let raw = 0;

  await t.step("with nothing on record the jump propagates", async () => {
    // Deliberate: with no transient registered there is nothing to blame the
    // jump on, so the coach is told the truth and decides.
    const e = await expenditure();
    assertEquals(e.status, "ok", e.reason);
    raw = e.tdee_kcal;
  });

  let eventId = 0;

  await t.step("registering the transient caps the step", async () => {
    const created = await api.post("/nutrition-events", {
      kind: "creatine_start",
      day: end,
      note: "5 g/day loading",
      request_id: uuid(),
    });
    assertEquals(created.status, 201);
    eventId = created.body.event.id;

    const e = await expenditure();
    assertEquals(e.status, "damped");
    assert(
      raw - e.tdee_kcal > 200,
      `the cap should hold the estimate well below the raw ${raw}, got ${e.tdee_kcal}`,
    );
    assert(e.reason.includes("creatine_start"), e.reason);
    assert(e.band_kcal >= 250, "a damped estimate does not claim a tight band");
  });

  await t.step(
    "withdrawing it returns the estimate to the raw solve",
    async () => {
      // An event registered on the wrong day damps a transient that never
      // happened, for a fortnight. Deleting one has to actually undo that, or
      // the register becomes a one-way ratchet on the estimate.
      const removed = await api.delete(`/nutrition-events/${eventId}`);
      assertEquals(removed.status, 200);

      const e = await expenditure();
      assertEquals(e.status, "ok");
      assertEquals(e.tdee_kcal, raw);
    },
  );
});
