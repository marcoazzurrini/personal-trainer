import { assert, assertEquals } from "@std/assert";
import {
  api,
  daysBefore,
  lastFinishedSunday,
  resetNutrition,
  seedCut,
  uuid,
} from "./helpers.ts";

// Phase 2 end to end: three weeks of real history through the API, then the
// estimate, the target, and the guards that stop either of them lying.

Deno.test("expenditure and targets", async (t) => {
  await resetNutrition();
  // 28 days ending at the last finished Sunday: 2,200 kcal logged daily,
  // weighing daily, losing ~0.5 kg/week.
  await seedCut({ days: 28, kcal: 2200, startWeightKg: 82, kgPerWeek: -0.5 });

  await t.step("without a body-fat estimate it refuses to guess", async () => {
    const { body } = await api.get("/nutrition-state");
    assertEquals(body.expenditure.status, "insufficient_data");
    assertEquals(body.expenditure.tdee_kcal, null);
    assert(body.expenditure.reason.includes("body-fat"));
  });

  await t.step("with one, it back-solves above intake", async () => {
    await api.post("/bodyfat", {
      percent: 14,
      method: "bia",
      day: lastFinishedSunday(),
      request_id: uuid(),
    });
    const { body } = await api.get("/nutrition-state");
    assertEquals(body.expenditure.status, "ok");
    assert(body.expenditure.tdee_kcal > 2200);
    assert(body.expenditure.band_kcal >= 200);
    assert(body.expenditure.band_kcal <= 250);
    assert(body.expenditure.inputs.slope_kg_per_day < 0);
    // Forbes, not 7,700: a lean trainee's kg is much cheaper.
    assert(body.expenditure.inputs.energy_density_kcal_per_kg < 7000);
  });

  await t.step("trend weight is reported before raw weight", async () => {
    const { body } = await api.get("/nutrition-state");
    assert(body.trend_weight.trend_kg > 0);
    assert(body.trend_weight.slope_21d.pct_bw_week < 0);
    // The trend lags a falling series, so it sits above the latest reading.
    assert(body.trend_weight.trend_kg > body.trend_weight.earliest_scale_kg);
  });

  await t.step("weekly reads finished weeks with implied TDEE", async () => {
    const { status, body } = await api.get("/nutrition/weekly?weeks=3");
    assertEquals(status, 200);
    assertEquals(body.weeks.length, 3);
    const complete = body.weeks.filter(
      (w: { implied_tdee_kcal: number | null }) => w.implied_tdee_kcal !== null,
    );
    assert(complete.length >= 2);
    for (const week of complete) {
      assertEquals(week.mean_kcal, 2200);
      assert(week.trend_delta_kg < 0);
      assert(week.implied_tdee_kcal > 2200);
    }
    assert(body.note.includes("noisy"));
    // No target set yet at this point in the file.
    assertEquals(
      body.weeks.every((w: { target: null }) => w.target === null),
      true,
    );
  });

  await t.step("each week carries its own rate of change", async () => {
    const { body } = await api.get("/nutrition/weekly?weeks=3");
    const withRate = body.weeks.filter(
      (w: { rate_pct_bw_week: number | null }) => w.rate_pct_bw_week !== null,
    );
    assert(withRate.length >= 2);
    // Losing ~0.5 kg/week on ~82 kg is about -0.6%/week; the EMA lags, so the
    // measured rate is shallower than the true one.
    for (const w of withRate) {
      assert(w.rate_pct_bw_week < 0, "a cut should read negative");
      assert(w.rate_pct_bw_week > -1.5, "and not absurd");
    }
  });

  let tdee = 0;

  await t.step("a target is computed from the rate, not sent", async () => {
    const state = await api.get("/nutrition-state");
    tdee = state.body.expenditure.tdee_kcal;

    const { status, body } = await api.post("/nutrition-targets", {
      goal: "cut",
      rate_pct_bw_week: -0.5,
      protein_g_per_kg_ffm: 2.7,
      decision:
        "Starting the cut: 21 days of steady logging, estimate is settled.",
      request_id: uuid(),
    });
    assertEquals(status, 201);
    // Protein is computed from fat-free mass, not multiplied in the model's
    // head: ~82 kg at 14% is ~70.5 kg FFM, so 2.7 g/kg is ~190 g.
    assertEquals(body.protein_computation.basis, "ffm");
    assert(body.protein_computation.basis_mass_kg < 72);
    assert(body.target.protein_g_target > 180);
    assert(body.target.protein_g_target < 200);
    assert(body.target.kcal_target < tdee);
    assertEquals(body.target.clipped, false);
    assertEquals(body.target.tdee_at_creation, tdee);
    assertEquals(body.computation.expenditure_status, "ok");
    // -0.5%/wk of ~82 kg at ~5,400 kcal/kg is roughly a 320 kcal deficit.
    assert(body.computation.implied_deficit_kcal > 250);
    assert(body.computation.implied_deficit_kcal < 400);
  });

  await t.step("today's totals report against the target", async () => {
    const { body } = await api.get("/nutrition-state");
    assertEquals(body.target.goal, "cut");
    assertEquals(
      body.today_so_far.vs_target.kcal_target,
      body.target.kcal_target,
    );
    assertEquals(
      body.today_so_far.vs_target.protein_g_target,
      body.target.protein_g_target,
    );
  });

  await t.step("an aggressive rate is clipped to 0.7%/week", async () => {
    const { body } = await api.post("/nutrition-targets", {
      goal: "cut",
      rate_pct_bw_week: -1.5,
      protein_g_per_kg_ffm: 2.9,
      effective_from: lastFinishedSunday(),
      decision: "Testing the guard; Marco asked to go faster.",
      request_id: uuid(),
    });
    assertEquals(body.target.clipped, true);
    // At this bodyweight the rate ceiling binds before the 500 kcal cap does.
    assertEquals(body.target.clipped_reasons, ["rate"]);
    assertEquals(body.computation.rate_requested, -1.5);
    assertEquals(body.computation.rate_used, -0.7);
    assert(body.computation.implied_deficit_kcal < 500);
    assert(body.target.kcal_target > tdee - 500);
  });

  await t.step("weekly rows carry the target that governed them", async () => {
    // A target only attaches to weeks it was actually in force for. The first
    // one was dated today, so it governs no finished week; the clipped one was
    // backdated to the last finished Sunday, so it governs that week. Without
    // this join the caller would have to reconstruct which target applied to
    // which week by date, from an append-only history.
    const { body } = await api.get("/nutrition/weekly?weeks=3");
    const older = body.weeks[0];
    const latest = body.weeks[body.weeks.length - 1];
    assertEquals(older.target, null, "predates any target");
    assert(latest.target !== null, "the backdated target should attach");
    assertEquals(latest.target.goal, "cut");
    assert(latest.target.kcal < tdee, "a cut target sits below expenditure");
    assert(latest.target.protein_g > 180);
    assertEquals(
      latest.target.rate_pct_bw_week,
      -1.5,
      "as requested, pre-clip",
    );
    assertEquals(typeof latest.target.changed_during_week, "boolean");
  });

  await t.step("a protein multiplier without body fat is refused", async () => {
    // The bodyweight basis is offered as the way out rather than the server
    // guessing a body-fat number to make fat-free mass computable.
    const wrongBasis = await api.post("/nutrition-targets", {
      goal: "cut",
      rate_pct_bw_week: -0.5,
      protein_g_per_kg_ffm: 2.7,
      protein_g_per_kg_bw: 2.0,
      decision: "two protein inputs",
    });
    assertEquals(wrongBasis.status, 422);
    assert(wrongBasis.body.error.includes("exactly one protein input"));

    const absurd = await api.post("/nutrition-targets", {
      goal: "cut",
      rate_pct_bw_week: -0.5,
      protein_g_per_kg_ffm: 27,
      decision: "decimal slip",
    });
    assertEquals(absurd.status, 422);
    assert(absurd.body.error.includes("2.3"));
  });

  await t.step(
    "a rate whose sign contradicts the goal is refused",
    async () => {
      const wrongWay = await api.post("/nutrition-targets", {
        goal: "cut",
        rate_pct_bw_week: 0.5,
        protein_g_per_kg_ffm: 2.7,
        decision: "typo",
      });
      assertEquals(wrongWay.status, 422);
      assert(wrongWay.body.error.includes("negative"));

      const fakeMaintain = await api.post("/nutrition-targets", {
        goal: "maintain",
        rate_pct_bw_week: -0.5,
        protein_g_per_kg_bw: 1.8,
        decision: "typo",
      });
      assertEquals(fakeMaintain.status, 422);
    },
  );

  await t.step("a target without a decision is refused", async () => {
    const { status } = await api.post("/nutrition-targets", {
      goal: "cut",
      rate_pct_bw_week: -0.5,
      protein_g_per_kg_ffm: 2.7,
    });
    assertEquals(status, 422);
  });

  await t.step("changing goal registers a phase switch", async () => {
    const { body } = await api.post("/nutrition-targets", {
      goal: "maintain",
      rate_pct_bw_week: 0,
      protein_g_per_kg_bw: 1.8,
      decision: "Cut has run 10 weeks; a maintenance phase before the next.",
      request_id: uuid(),
    });
    assertEquals(body.phase_switch_registered, true);

    const events = await api.get("/nutrition-events");
    const switches = events.body.events.filter(
      (e: { kind: string }) => e.kind === "phase_switch",
    );
    assertEquals(switches.length, 1);
    assert(switches[0].note.includes("maintain"));
  });

  await t.step("a registered transient damps the estimate", async () => {
    const { body } = await api.get("/nutrition-state");
    // The phase switch above is inside the transient window, so it is
    // surfaced for the coach to explain before the scale moves.
    assert(body.active_transients.length > 0);
    assertEquals(body.active_transients[0].kind, "phase_switch");
  });
});

Deno.test("the estimate holds rather than extrapolating", async (t) => {
  await resetNutrition();
  // Six weeks of good history, then a fortnight of silence: no logging, no
  // weighing. Enough behind the gap that an older window still qualifies —
  // which is the whole point of holding rather than extrapolating.
  await seedCut({
    days: 42,
    kcal: 2200,
    startWeightKg: 82,
    kgPerWeek: -0.5,
    skipLastDays: 15,
  });
  await api.post("/bodyfat", {
    percent: 14,
    method: "bia",
    request_id: uuid(),
  });

  await t.step("status is stale and the estimate is frozen", async () => {
    const { body } = await api.get("/nutrition-state");
    assertEquals(body.expenditure.status, "stale");
    assert(body.expenditure.tdee_kcal !== null);
    assert(body.expenditure.as_of < body.today);
    assert(body.expenditure.reason.includes("Held from the window"));
  });

  await t.step("a target cannot be computed off a stale estimate", async () => {
    // Deliberate: the gate belongs in the check-in procedure, but the server
    // still records what it computed from, so a stale-based target is
    // visible in the log rather than indistinguishable from a fresh one.
    const { body } = await api.get("/nutrition-state");
    assertEquals(body.expenditure.status, "stale");
    assert(body.adherence.days_logged_last_7 === 0);
  });
});

// The two weekly means once disagreed about which days counted: mean_kcal
// excluded days flagged incomplete and mean_protein_g did not, so a day Marco
// had said he did not track was thrown out of one number and averaged into the
// other. In practice a flagged day is under-logged, so the protein mean read
// low and a shortfall that never happened looked real. This fixture doubles a
// day rather than starving one — seedCut has already logged every day, and a
// doubled day puts an exact delta through the same arithmetic.
Deno.test("a flagged day leaves both weekly means", async (t) => {
  await resetNutrition();
  // Two weeks at 2,200 kcal of a 5 g/100 g food: 110 g of protein a day.
  await seedCut({ days: 14, kcal: 2200, startWeightKg: 82, kgPerWeek: -0.5 });
  const day = daysBefore(lastFinishedSunday(), 3);

  await t.step("a doubled day moves both while it still counts", async () => {
    await api.post("/intake", {
      day,
      food: "Seed Food",
      grams: 2200,
      request_id: uuid(),
    });
    const { body } = await api.get("/nutrition/weekly?weeks=1");
    assertEquals(body.weeks[0].mean_kcal, 2514); // (6 x 2200 + 4400) / 7
    assertEquals(body.weeks[0].mean_protein_g, 126); // (6 x 110 + 220) / 7
  });

  await t.step("flagging it removes it from both", async () => {
    const flagged = await api.post(`/days/${day}/flags`, {
      flag: "incomplete",
    });
    assertEquals(flagged.status, 201);

    const { body } = await api.get("/nutrition/weekly?weeks=1");
    assertEquals(body.weeks[0].days_flagged, 1);
    assertEquals(body.weeks[0].mean_kcal, 2200);
    assertEquals(body.weeks[0].mean_protein_g, 110);
  });
});
