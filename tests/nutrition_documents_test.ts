import { assert, assertStringIncludes } from "@std/assert";
import { documentPath, SKILL } from "./skill.ts";

Deno.test("nutrition documents agree with food identity, corrections and target storage", async () => {
  const skill = await Deno.readTextFile(SKILL);
  const ref = await Deno.readTextFile(documentPath("reference/nutrition"));
  const onboarding = await Deno.readTextFile(
    documentPath("tasks/nutrition-onboarding"),
  );
  const migration = await Deno.readTextFile(
    "db/migrations/20260807160000_nutrition_tracking.sql",
  );
  assertStringIncludes(
    migration,
    "create unique index foods_name_key on foods (lower(name))",
  );
  assertStringIncludes(skill, "case-insensitive and unique");
  assertStringIncludes(skill, "`POST /foods` still requires a `request_id`");
  assertStringIncludes(
    ref,
    "correcting a food\nrewrites historical intake linked to that food",
  );
  assert(!ref.includes("editing a meal — or the foods in it"));
  assertStringIncludes(
    onboarding,
    "conversational guidance, not a saved target",
  );
  assertStringIncludes(
    onboarding,
    "Do not call it on this path, invent calories",
  );
  assertStringIncludes(ref, "No protein-only persisted target");
  const operation = await Deno.readTextFile("api/nutrition/targets.ts");
  assert(
    operation.indexOf("if (expenditure.tdee_kcal === null)") <
      operation.indexOf("insert into nutrition_targets"),
  );
});
