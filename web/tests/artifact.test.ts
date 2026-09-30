import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, it } from "vitest";

import { placeholder, stampOutput } from "../scripts/build.ts";

const { join, resolve } = path;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true }))
  );
});
async function fixture(asset = "asset") {
  const directory = await mkdtemp(join(tmpdir(), "trainer-web-artifact-"));
  directories.push(directory);
  await mkdir(join(directory, "server"));
  await writeFile(
    join(directory, "server/index.mjs"),
    `export default "${placeholder}";`
  );
  await writeFile(join(directory, "asset.txt"), asset);
  return directory;
}

it("loads the dashboard builder without installing the API's dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trainer-web-builder-"));
  directories.push(directory);
  await mkdir(join(directory, "web/scripts"), { recursive: true });
  await mkdir(join(directory, "scripts"));
  await copyFile("scripts/build.ts", join(directory, "web/scripts/build.ts"));
  await copyFile(
    "../scripts/source-revision.ts",
    join(directory, "scripts/source-revision.ts")
  );
  const url = pathToFileURL(resolve(directory, "web/scripts/build.ts")).href;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`],
    {
      cwd: directory,
      env: {},
      encoding: "utf-8",
    }
  );
  expect(child.status, child.stderr).toBe(0);
});

it("keeps the Vite compiler on Node when Bun runs the builder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trainer-web-runtime-"));
  directories.push(directory);
  const web = join(directory, "web");
  const environment = { PATH: process.env.PATH, HOME: directory };
  for (const args of [
    ["init", "--quiet"],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Fixture",
    ],
  ]) {
    const git = spawnSync("git", args, {
      cwd: directory,
      env: environment,
      encoding: "utf-8",
    });
    expect(git.status, git.stderr).toBe(0);
  }
  await mkdir(join(web, "scripts"), { recursive: true });
  await mkdir(join(web, "node_modules/vite/bin"), { recursive: true });
  await mkdir(join(directory, "scripts"));
  await copyFile("scripts/build.ts", join(web, "scripts/build.ts"));
  await copyFile(
    "../scripts/source-revision.ts",
    join(directory, "scripts/source-revision.ts")
  );
  await writeFile(
    join(web, "node_modules/vite/package.json"),
    JSON.stringify({ name: "vite" })
  );
  await writeFile(
    join(web, "node_modules/vite/bin/vite.js"),
    `if (process.versions.bun) throw new Error("Vite must run on Node");
const fs = require("node:fs");
fs.mkdirSync(".output/server", { recursive: true });
fs.writeFileSync(".output/server/index.mjs", ${JSON.stringify(placeholder)});
`
  );
  const child = spawnSync("bun", ["--no-env-file", "scripts/build.ts"], {
    cwd: web,
    env: environment,
    encoding: "utf-8",
    timeout: 10_000,
  });
  expect(child.status, child.stderr).toBe(0);
  const metadata = JSON.parse(
    await readFile(join(web, ".output/build.json"), "utf-8")
  );
  expect(metadata.revision).toBeNull();
  expect(metadata.digest).toMatch(/^[a-f0-9]{64}$/u);
});

it("stamps the exact output and preserves an honest uncommitted identity", async () => {
  const directory = await fixture();
  const metadata = await stampOutput(directory, null);
  expect(metadata.revision).toBeNull();
  expect(metadata.digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(await readFile(join(directory, "server/index.mjs"), "utf-8")).toBe(
    `export default "${metadata.digest}";`
  );
  expect(
    JSON.parse(await readFile(join(directory, "build.json"), "utf-8"))
  ).toEqual(metadata);
});

it("includes static assets and relative paths in artifact identity", async () => {
  const first = await fixture("first");
  const second = await fixture("second");
  expect((await stampOutput(first, null)).digest).not.toBe(
    (await stampOutput(second, null)).digest
  );
  const third = await fixture("same");
  const fourth = await fixture("same");
  await writeFile(join(fourth, "additional.txt"), "");
  expect((await stampOutput(third, null)).digest).not.toBe(
    (await stampOutput(fourth, null)).digest
  );
});

it("refuses duplicate placeholders and already-stamped output", async () => {
  const directory = await fixture(placeholder);
  await expect(stampOutput(directory, null)).rejects.toThrow("exactly one");
  const once = await fixture();
  await stampOutput(once, null);
  await expect(stampOutput(once, null)).rejects.toThrow("exactly one");
});
