import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { assert, assertStringIncludes } from "./assertions.ts";
import { documentPath, SKILL } from "./skill.ts";
// Source contracts, not live coach behavior or a general secret detector.
test("reporting documents require sanitized public evidence and specific consent", async () => {
  const reporting = await readFile(
    documentPath("tasks/reporting-problems"),
    "utf-8"
  );
  const skill = await readFile(SKILL, "utf-8");
  for (const phrase of [
    "public repository",
    "every field",
    "never publish\ncredentials even with consent",
    "synthetic",
    "[REDACTED]",
    "explicit consent",
    "ordinary sanitized reporting needs no blanket confirmation",
  ]) {
    assertStringIncludes(reporting, phrase);
  }
  assert(!reporting.includes("response verbatim"));
  assertStringIncludes(
    skill,
    "Remove credentials and cookies from every field"
  );
});
test("reporting recovery distinguishes expected refusals and bounds reporting failures", async () => {
  const reporting = (
    await readFile(documentPath("tasks/reporting-problems"), "utf-8")
  ).replaceAll(/\s+/gu, " ");
  const skill = await readFile(SKILL, "utf-8");
  for (const phrase of [
    "Unknown reference",
    "Expired authentication (401)",
    "Actionable validation (422)",
    "unexplained 500",
    "at most one issue lookup",
    "one filing or comment",
    "stop reporting for this incident",
    "delivery is unknown",
    "not exactly-once delivery",
    "correlation marker only",
    "no locks, receipts or replay guarantee",
    "`request_id` may create duplicates",
    "Comments have no request-ID deduplication",
    "same `request_id`",
    "Do not blindly retry",
    "inspect GitHub before another attempt",
    "including closed issues",
    "inspect the destination issue's comments",
    "leave it unresolved rather than repeating the write",
    "urgent symptom guidance",
  ]) {
    assertStringIncludes(reporting, phrase);
  }
  assert(!skill.includes("always safe"));
  assert(!skill.includes("If a call errors"));
  assertStringIncludes(skill, "Expected refusals recover, not report");
  assertStringIncludes(
    await readFile(documentPath("tasks/nutrition-logging"), "utf-8"),
    "refusal is expected recovery, not a bug report"
  );
});
