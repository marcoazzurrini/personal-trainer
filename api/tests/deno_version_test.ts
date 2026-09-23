import { assert, assertEquals, assertThrows } from "@std/assert";

function assertDenoVersions(version: string, workflow: string): void {
  assert(
    /^\d+\.\d+\.\d+$/.test(version),
    "Pin an exact Deno test-tool version.",
  );
  const jobs = [...workflow.matchAll(/uses: denoland\/setup-deno@/g)];
  const versions = [...workflow.matchAll(/deno-version:\s*(\S+)/g)];
  assertEquals(
    jobs.length,
    2,
    "Checks and HTTP tests use Deno, not deployment.",
  );
  assertEquals(
    versions.map((match) => match[1]),
    jobs.map(() => version),
    "Every CI Deno test tool must match package.json engines.deno.",
  );
}

const { engines } = JSON.parse(await Deno.readTextFile("package.json"));
const workflow = await Deno.readTextFile(".github/workflows/ci.yml");

Deno.test("CI pins the Deno test tool independently of the Worker runtime", () => {
  assertDenoVersions(engines.deno, workflow);
  const deploy = workflow.split("\n  deploy:\n")[1];
  assert(deploy);
  assert(!deploy.includes("setup-deno"));
  assert(!deploy.includes("deno task"));
});

Deno.test("Deno checks exclude generated copies of other worktrees", async () => {
  const config = JSON.parse(await Deno.readTextFile("deno.json"));
  assert(config.exclude.includes(".delta"));
});

Deno.test("a floating, missing or mismatched Deno test-tool pin fails", () => {
  for (const version of ["2", "2.x", "^2.9.6", "", "0.0.0"]) {
    assertThrows(() => assertDenoVersions(version, workflow));
  }
  for (const match of workflow.matchAll(/deno-version:\s*\S+/g)) {
    for (const replacement of ["deno-version: 0.0.0", ""]) {
      const changed = workflow.slice(0, match.index) + replacement +
        workflow.slice(match.index + match[0].length);
      assertThrows(() => assertDenoVersions(engines.deno, changed));
    }
  }
});
