import { afterEach, expect, it } from "vitest";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { placeholder, stampOutput } from "../scripts/build.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true })),
  );
});
async function fixture(asset = "asset") {
  const directory = await mkdtemp(join(tmpdir(), "trainer-web-artifact-"));
  directories.push(directory);
  await mkdir(join(directory, "server"));
  await writeFile(
    join(directory, "server/index.mjs"),
    `export default "${placeholder}";`,
  );
  await writeFile(join(directory, "asset.txt"), asset);
  return directory;
}

it("loads the dashboard builder without installing the API's dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trainer-web-builder-"));
  directories.push(directory);
  await mkdir(join(directory, "web/scripts"), { recursive: true });
  await mkdir(join(directory, "scripts"));
  await copyFile("scripts/build.mjs", join(directory, "web/scripts/build.mjs"));
  await copyFile(
    "../scripts/source-revision.mjs",
    join(directory, "scripts/source-revision.mjs"),
  );
  const url = pathToFileURL(resolve(directory, "web/scripts/build.mjs")).href;
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(url)})`,
  ], {
    cwd: directory,
    env: {},
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
});

it("stamps the exact output and preserves an honest uncommitted identity", async () => {
  const directory = await fixture();
  const metadata = await stampOutput(directory, null);
  expect(metadata.revision).toBeNull();
  expect(metadata.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(await readFile(join(directory, "server/index.mjs"), "utf8")).toBe(
    `export default "${metadata.digest}";`,
  );
  expect(JSON.parse(await readFile(join(directory, "build.json"), "utf8")))
    .toEqual(metadata);
});

it("includes static assets and relative paths in artifact identity", async () => {
  const first = await fixture("first");
  const second = await fixture("second");
  expect((await stampOutput(first, null)).digest).not.toBe(
    (await stampOutput(second, null)).digest,
  );
  const third = await fixture("same");
  const fourth = await fixture("same");
  await writeFile(join(fourth, "additional.txt"), "");
  expect((await stampOutput(third, null)).digest).not.toBe(
    (await stampOutput(fourth, null)).digest,
  );
});

it("refuses duplicate placeholders and already-stamped output", async () => {
  const directory = await fixture(placeholder);
  await expect(stampOutput(directory, null)).rejects.toThrow("exactly one");
  const once = await fixture();
  await stampOutput(once, null);
  await expect(stampOutput(once, null)).rejects.toThrow("exactly one");
});
