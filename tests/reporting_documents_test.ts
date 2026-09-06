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
