import { assert, assertStringIncludes } from "@std/assert";
import { documentPath, SKILL } from "./skill.ts";

// Source contracts, not live coach behavior or a general secret detector.
Deno.test("reporting documents require sanitized public evidence and specific consent", async () => {
  const reporting = await Deno.readTextFile(
    documentPath("tasks/reporting-problems"),
  );
  const skill = await Deno.readTextFile(SKILL);
  for (
    const phrase of [
      "public repository",
      "every field",
      "never publish\ncredentials even with consent",
      "synthetic",
      "[REDACTED]",
      "explicit consent",
      "ordinary sanitized reporting needs no blanket confirmation",
    ]
  ) assertStringIncludes(reporting, phrase);
  assert(!reporting.includes("response verbatim"));
  assertStringIncludes(
    skill,
    "Remove credentials and cookies from every field",
  );
});

Deno.test("reporting recovery distinguishes expected refusals and bounds reporting failures", async () => {
  const reporting =
    (await Deno.readTextFile(documentPath("tasks/reporting-problems"))).replace(
      /\s+/g,
      " ",
    );
  const skill = await Deno.readTextFile(SKILL);
  for (
    const phrase of [
      "Unknown reference",
      "Expired authentication (401)",
      "Actionable validation (422)",
      "unexplained 500",
      "at most one issue lookup",
      "one filing or comment",
      "stop reporting for this incident",
      "delivery is unknown",
      "not exactly-once delivery",
      "Comments have no request-ID deduplication",
      "same `request_id`",
      "urgent symptom guidance",
    ]
  ) assertStringIncludes(reporting, phrase);
  assert(!skill.includes("always safe"));
  assert(!skill.includes("If a call errors"));
  assertStringIncludes(skill, "Expected refusals recover, not report");
  assertStringIncludes(
    await Deno.readTextFile(documentPath("tasks/nutrition-logging")),
    "refusal is expected recovery, not a bug report",
  );
});
