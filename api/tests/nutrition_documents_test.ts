import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { assert, assertStringIncludes } from "./assertions.ts";
import { documentPath, SKILL } from "./skill.ts";

test("nutrition documents agree with food identity, corrections and target storage", async () => {
  const skill = await readFile(SKILL, "utf-8");
  const ref = await readFile(documentPath("reference/nutrition"), "utf-8");
  const onboarding = await readFile(
    documentPath("tasks/nutrition-onboarding"),
    "utf-8"
  );
  const migration = await readFile("db/migrations/0001_record.sql", "utf-8");
  assertStringIncludes(
    migration,
    "create unique index foods_name_key on foods (name_key)"
  );
  assertStringIncludes(skill, "case-insensitive and unique");
  assertStringIncludes(skill, "`POST /foods` still requires a `request_id`");
  assertStringIncludes(
    ref,
    "correcting a food updates the\ncalculated totals of historical intake linked to that food"
  );
  assert(!ref.includes("editing a meal — or the foods in it"));
  assertStringIncludes(
    ref,
    "Food-backed entries record the food and grams actually eaten"
  );
  assertStringIncludes(
    ref,
    "An explicit macro override applies until the next correction"
  );
  assert(!ref.includes("Every entry stores its own kcal and macros"));
  assertStringIncludes(
    onboarding,
    "conversational guidance, not a saved target"
  );
  assertStringIncludes(
    onboarding,
    "Do not call it on this path, invent calories"
  );
  assertStringIncludes(ref, "No protein-only persisted target");
  const operation = await readFile("api/nutrition/targets.ts", "utf-8");
  const refusal = operation.indexOf("if (expenditure.tdee_kcal === null)");
  const write = operation.indexOf("await repository.save(");
  assert(refusal !== -1 && write !== -1 && refusal < write);
});
