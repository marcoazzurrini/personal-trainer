import { assert, assertEquals, assertThrows } from "@std/assert";

function assertDenoVersions(dockerfile: string, workflow: string): void {
  const image = dockerfile.match(/^FROM denoland\/deno:(\d+\.\d+\.\d+)$/m);
  assert(image, "Dockerfile must pin an exact production Deno version.");
  const jobs = [...workflow.matchAll(/uses: denoland\/setup-deno@/g)];
  const versions = [...workflow.matchAll(/deno-version:\s*(\S+)/g)];
  assertEquals(jobs.length, 2, "Check both native CI jobs.");
  assertEquals(
    versions.map((match) => match[1]),
    [image[1], image[1]],
    "Both CI runtimes must match the authoritative Dockerfile pin.",
  );
}

const dockerfile = await Deno.readTextFile("Dockerfile");
const workflow = await Deno.readTextFile(".github/workflows/ci.yml");

Deno.test("both CI Deno versions match the production image", () => {
  assertDenoVersions(dockerfile, workflow);
});

Deno.test("changing any one Deno declaration fails parity", () => {
  const changedImage = dockerfile.replace(
    /denoland\/deno:[\d.]+/,
    "denoland/deno:0.0.0",
  );
  assertThrows(() => assertDenoVersions(changedImage, workflow));
  for (const match of workflow.matchAll(/deno-version:\s*\S+/g)) {
    const changedJob = workflow.slice(0, match.index) + "deno-version: 0.0.0" +
      workflow.slice(match.index + match[0].length);
    assertThrows(() => assertDenoVersions(dockerfile, changedJob));
  }
});
