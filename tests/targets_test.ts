import { assert, assertEquals } from "@std/assert";
import {
  api,
  daysBefore,
  expenditureWindow,
  lastFinishedSunday,
  lastMonday,
  resetNutrition,
  seedBodyfat,
  seedFood,
  seedIntakeDays,
  seedWeighIns,
  uuid,
} from "./helpers.ts";

// Three target behaviours that nutrition_phase2_test cannot reach from where
// it stands: the guard that only fires at a bodyweight it does not seed, the
// onboarding path that runs before any estimate exists, and a weekly field it
// asserts the type of rather than the value.

Deno.test("a target is computable before any estimate exists", async (t) => {
  await resetNutrition();
  // The documented provisional path. Onboarding has a goal and no history, so
  // requiring an expenditure estimate would mean Marco eats to nothing for
  // three weeks. An explicit kcal_target is accepted instead — and the row
  // records that it was not computed, so a later reader can tell a provisional
  // target from a solved one rather than having to trust the decision text.
  await seedWeighIns([daysBefore(lastFinishedSunday(), 1)], 82);

  await t.step("the estimate really is absent", async () => {
    const { body } = await api.get("/nutrition-state");
    assertEquals(body.expenditure.status, "insufficient_data");
  });

  await t.step(
    "an explicit target is accepted and marked as such",
    async () => {
      const { status, body } = await api.post("/nutrition-targets", {
        goal: "cut",
        rate_pct_bw_week: -0.5,
        kcal_target: 2300,
        protein_g_target: 180,
        decision:
          "Provisional: no history yet, so this is a starting point to be re-solved once three weeks of logging exist.",
        request_id: uuid(),
      });
      assertEquals(status, 201);
      assertEquals(body.target.kcal_target, 2300);
      assertEquals(body.target.protein_g_target, 180);
      // The tells that this was handed in rather than solved for.
      assertEquals(body.target.tdee_at_creation, null);
      assertEquals(body.computation, null);
      assertEquals(body.protein_computation, null);
      assertEquals(body.target.clipped, false);
    },
  );

  await t.step("a rate-based target still refuses, naming why", async () => {
    // The provisional path is a deliberate exception, not a way around the
    // requirement: ask the server to compute and it still says what is missing.
    const { status, body } = await api.post("/nutrition-targets", {
      goal: "cut",
      rate_pct_bw_week: -0.5,
      protein_g_target: 180,
      decision: "asking for the computed one",
    });
    assertEquals(status, 422);
    assert(body.error.includes("cannot be computed yet"), body.error);
  });
});

Deno.test("the deficit cap binds where the rate cap does not", async (t) => {
  await resetNutrition();
  // Both guards exist because they are not the same guard. A percentage and an
  // absolute number diverge as bodyweight changes: at 82 kg the rate ceiling
  // catches an over-aggressive cut first, but at 120 kg a perfectly legal
  // -0.7%/week already implies more than 500 kcal/day. expenditure_test proves
  // that arithmetic; this proves the route reports which guard actually fired,
  // because clipped_reason is what the decision log will say later.
  const days = expenditureWindow();
  await seedFood();
  await seedWeighIns(days, 120, -0.5);
  await seedIntakeDays(days, 3000);
  await seedBodyfat(30);

  await t.step("a legal rate is clipped by the absolute deficit", async () => {
    const { status, body } = await api.post("/nutrition-targets", {
      goal: "cut",
      rate_pct_bw_week: -0.7, // exactly the rate ceiling: that guard cannot fire
      protein_g_per_kg_ffm: 2.7,
      decision: "Testing which guard binds at this bodyweight.",
      request_id: uuid(),
    });
    assertEquals(status, 201);
    assertEquals(body.target.clipped, true);
    assertEquals(body.target.clipped_reason, "deficit");
    assertEquals(
      body.computation.rate_used,
      -0.7,
      "the rate was never clipped",
    );
    assertEquals(body.computation.implied_deficit_kcal, 500);
    assertEquals(
      body.target.kcal_target,
      body.computation.tdee_kcal - 500,
      "the target sits exactly one cap below expenditure",
    );
  });

  await t.step(
    "protein is computed off fat-free mass, not bodyweight",
    async () => {
      const { body } = await api.get("/nutrition-targets");
      const active = body.active;
      // 120 kg at 30% is 84 kg of fat-free mass, so 2.7 g/kg is ~227 g — a long
      // way from the ~324 g that multiplying by bodyweight would have produced.
      assert(active.protein_g_target > 210, `${active.protein_g_target}`);
      assert(active.protein_g_target < 245, `${active.protein_g_target}`);
    },
  );
});

Deno.test("recomp and gain are guarded like cuts", async (t) => {
  await resetNutrition();
  // A steady 82 kg with a full window, so every clip is measured against a
  // real estimate rather than a handed-in number. recomp had zero coverage
  // once — the enum value existed, the doctrine existed, and no test had ever
  // sent one — and the gap held two real bugs: a doctrine-compliant recomp
  // was 422'd into relabelling itself as a cut (registering a phase switch
  // that never happened), and any gain passed through unclipped.
  const days = expenditureWindow();
  await seedFood();
  await seedWeighIns(days, 82, -0.2);
  await seedIntakeDays(days, 2400);
  await seedBodyfat(14);

  await t.step(
    "a doctrine recomp is accepted and clipped in kcal",
    async () => {
      const { status, body } = await api.post("/nutrition-targets", {
        goal: "recomp",
        rate_pct_bw_week: -0.5, // legal for a cut; past recomp's kcal floor
        protein_g_per_kg_ffm: 2.7,
        decision: "Recomp: high protein, slight deficit, judged by strength.",
        request_id: uuid(),
      });
      assertEquals(status, 201, body.error);
      assertEquals(body.target.goal, "recomp");
      assertEquals(body.target.clipped, true);
      assertEquals(body.target.clipped_reason, "recomp_deficit");
      assertEquals(
        body.target.kcal_target,
        body.target.tdee_at_creation - 200,
        "maintenance to -200 kcal/day, enforced in kcal at any bodyweight",
      );
    },
  );

  await t.step("a clipped recomp is not a phase switch", async () => {
    // The old misfire chain: recomp rejected -> coach relabels it a cut ->
    // a phase_switch event registers -> the estimate damps against water
    // that never moved. The chain must be dead at its first link.
    const { status, body } = await api.post("/nutrition-targets", {
      goal: "recomp",
      rate_pct_bw_week: -0.3,
      protein_g_per_kg_ffm: 2.7,
      decision: "Same phase, slightly gentler.",
      request_id: uuid(),
    });
    assertEquals(status, 201);
    assertEquals(body.phase_switch_registered, false);
  });

  await t.step("an absurd recomp rate is still refused", async () => {
    const { status, body } = await api.post("/nutrition-targets", {
      goal: "recomp",
      rate_pct_bw_week: -1.0,
      protein_g_per_kg_ffm: 2.7,
      decision: "nope",
    });
    assertEquals(status, 422);
    assert(body.error.includes("recomp"), body.error);
    assert(body.error.includes("-0.7"), body.error);
  });

  await t.step("a gaining recomp is refused too", async () => {
    const { status } = await api.post("/nutrition-targets", {
      goal: "recomp",
      rate_pct_bw_week: 0.3,
      protein_g_per_kg_ffm: 2.7,
      decision: "nope",
    });
    assertEquals(status, 422);
  });

  await t.step("an aggressive gain is clipped, not stored", async () => {
    const { status, body } = await api.post("/nutrition-targets", {
      goal: "gain",
      rate_pct_bw_week: 2.0,
      protein_g_per_kg_bw: 1.8,
      decision: "Bulk. The server had better say no to this rate.",
      request_id: uuid(),
    });
    assertEquals(status, 201, body.error);
    assertEquals(body.target.clipped, true);
    assertEquals(body.target.clipped_reason, "rate");
    assertEquals(body.computation.rate_requested, 2.0);
    assertEquals(body.computation.rate_used, 0.5);
    // recomp -> gain is a genuine phase switch; the guard must not eat it.
    assertEquals(body.phase_switch_registered, true);
  });

  await t.step("a conservative gain is untouched", async () => {
    const { status, body } = await api.post("/nutrition-targets", {
      goal: "gain",
      rate_pct_bw_week: 0.3,
      protein_g_per_kg_bw: 1.8,
      decision: "Lean gain at the doctrine's default.",
      request_id: uuid(),
    });
    assertEquals(status, 201);
    assertEquals(body.target.clipped, false);
    assertEquals(body.target.clipped_reason, null);
  });
});

Deno.test("a week knows whether its target moved underneath it", async (t) => {
  await resetNutrition();
  const weekStart = lastMonday(); // the last finished week: Monday to Sunday
  await seedWeighIns([daysBefore(lastFinishedSunday(), 1)], 82);

  const provisional = (effectiveFrom: string, kcal: number) => ({
    goal: "cut",
    rate_pct_bw_week: -0.5,
    kcal_target: kcal,
    protein_g_target: 180,
    effective_from: effectiveFrom,
    decision: `Set on ${effectiveFrom}.`,
    request_id: uuid(),
  });

  const lastFinishedWeek = async () => {
    const { body } = await api.get("/nutrition/weekly?weeks=1");
    return body.weeks[body.weeks.length - 1];
  };

  await t.step("a target in force from the Monday did not change", async () => {
    // The flag means "superseded mid-week", so a target that was already in
    // force when the week opened must not set it. Otherwise every week would
    // read as unstable and the signal would be worthless.
    await api.post("/nutrition-targets", provisional(weekStart, 2300));
    const week = await lastFinishedWeek();
    assertEquals(week.week_start, weekStart);
    assertEquals(week.target.kcal, 2300);
    assertEquals(week.target.changed_during_week, false);
  });

  await t.step("a target set mid-week does", async () => {
    // Why the caller needs this: the week's mean intake is being compared
    // against a single target, and if the target moved on Thursday that
    // comparison is against a number that only governed half the week.
    await api.post(
      "/nutrition-targets",
      provisional(daysBefore(lastFinishedSunday(), 3), 2100),
    );
    const week = await lastFinishedWeek();
    assertEquals(week.target.changed_during_week, true);
    assertEquals(
      week.target.kcal,
      2100,
      "the target reported is the one in force at the week's end",
    );
  });
});
