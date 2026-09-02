import { assert } from "@std/assert";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_DEFICIT_KCAL,
  MAX_GAIN_RATE_PCT_BW_WEEK,
  MAX_LOSS_RATE_PCT_BW_WEEK,
  MAX_RECOMP_DEFICIT_KCAL,
  MAX_SURPLUS_KCAL,
  MIN_WEIGH_INS_PER_WEEK,
  MIN_WINDOW_DAYS,
  PROTEIN_G_PER_KG_BW_RANGE,
  PROTEIN_G_PER_KG_FFM_RANGE,
} from "../supabase/functions/api/nutrition/expenditure.ts";

// The server owns these numbers, and the docs quote them as literals — the
// clip rates in four documents, the protein bands in four, the window in two.
// The copies are deliberate (a doctrine document that outsourced its numbers
// would stop reading as doctrine), so what keeps them honest is this test:
// change a constant, and every document still citing the old value goes red
// by name. This is how the "planned dose lives in the intent as prose" class
// of fossil gets caught at the commit instead of by an outside reviewer.

const DOCS = "plugin/skills/personal-trainer/references";
const cache = new Map<string, string>();

async function doc(name: string): Promise<string> {
  if (!cache.has(name)) {
    cache.set(name, await Deno.readTextFile(`${DOCS}/${name}.md`));
  }
  return cache.get(name)!;
}

async function cites(name: string, needle: string) {
  assert(
    (await doc(name)).includes(needle),
    `${name}.md no longer cites "${needle}" — either the constant moved and this doc still holds the old number, or the sentence was reworded away from the value. Re-align them.`,
  );
}

Deno.test("every doc citing a server number cites the current one", async (t) => {
  await t.step("the cut's clips: rate and absolute deficit", async () => {
    for (
      const name of [
        "method/nutrition",
        "reference/nutrition",
        "tasks/nutrition-checkin",
        "tasks/nutrition-onboarding",
      ]
    ) {
      await cites(name, `${MAX_LOSS_RATE_PCT_BW_WEEK}%/week`);
      await cites(name, `${MAX_DEFICIT_KCAL} kcal/day`);
    }
  });

  await t.step("the gain's clips: rate and absolute surplus", async () => {
    for (
      const name of [
        "method/nutrition",
        "reference/nutrition",
        "tasks/nutrition-checkin",
      ]
    ) {
      await cites(name, `${MAX_GAIN_RATE_PCT_BW_WEEK}%/week`);
      await cites(name, `${MAX_SURPLUS_KCAL} kcal/day`);
    }
  });

  await t.step("the recomp deficit floor", async () => {
    for (
      const name of [
        "method/nutrition",
        "reference/nutrition",
        "tasks/nutrition-checkin",
      ]
    ) {
      await cites(name, `${MAX_RECOMP_DEFICIT_KCAL} kcal/day`);
    }
  });

  await t.step("the expenditure window and its thresholds", async () => {
    for (const name of ["reference/nutrition", "tasks/nutrition-onboarding"]) {
      await cites(name, `${MIN_WINDOW_DAYS} usable days`);
      await cites(name, `${DEFAULT_WINDOW_DAYS}`);
    }
    await cites(
      "reference/nutrition",
      `${MIN_WEIGH_INS_PER_WEEK} weigh-in day`,
    );
  });

  await t.step("the protein bands", async () => {
    const ffm = PROTEIN_G_PER_KG_FFM_RANGE.join("–");
    const bw = PROTEIN_G_PER_KG_BW_RANGE.join("–");
    for (
      const name of [
        "method/nutrition",
        "reference/nutrition",
        "tasks/nutrition-checkin",
        "tasks/nutrition-onboarding",
      ]
    ) {
      await cites(name, ffm);
      await cites(name, bw);
    }
  });
});
