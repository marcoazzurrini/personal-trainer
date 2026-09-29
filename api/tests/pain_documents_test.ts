import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { assert, assertStringIncludes } from "./assertions.ts";
import { documentPath, SKILL } from "./skill.ts";
// Wording/precedence tripwires only, not clinical validation.
test("pain documents put urgent systemic symptoms before tools and local training", async () => {
  const skill = await readFile(SKILL, "utf-8");
  const pain = await readFile(documentPath("tasks/pain"), "utf-8");
  assert(
    skill.indexOf("## Urgent symptoms come first") <
      skill.indexOf("Two reflexes")
  );
  for (const phrase of [
    "before any tool call",
    "112 in Italy/EU",
    "not drive himself",
    "Do not train another area",
  ]) {
    assertStringIncludes(skill, phrase);
  }
  assert(
    pain.indexOf("## Urgent systemic symptoms") <
      pain.indexOf("## Three local buckets")
  );
  for (const phrase of [
    "marked breathlessness",
    "before token acquisition",
    "Muscle soreness",
    "Joint or tendon complaint",
    "Stop and refer",
    "triage, not diagnosis",
    "not clinical validation",
  ]) {
    assertStringIncludes(pain, phrase);
  }
  assert(
    !pain
      .slice(
        pain.indexOf("## Three local buckets"),
        pain.indexOf("## Mid-session rules")
      )
      .includes("chest pain")
  );
  for (const doc of ["tasks/logging", "tasks/reporting-problems"]) {
    assertStringIncludes(
      (await readFile(documentPath(doc), "utf-8")).replaceAll(/\s+/gu, " "),
      "urgent care is addressed"
    );
  }
});
