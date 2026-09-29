import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { sourceRevision } from "../../scripts/source-revision.ts";

const { relative, resolve } = nodePath;

export const placeholder = "__TRAINER_WEB_BUILD_DIGEST_PLACEHOLDER__";

export interface DashboardBuild {
  revision: string | null;
  digest: string;
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? files(path) : [path];
      })
    )
  )
    .flat()
    .toSorted();
}

/** Hash the complete compiler output before stamping its single placeholder. */
export async function stampOutput(
  directory: string,
  revision: string | null
): Promise<DashboardBuild> {
  const hash = createHash("sha256");
  const matches: { path: string; bytes: Buffer }[] = [];
  for (const path of await files(directory)) {
    const bytes = await readFile(path);
    hash.update(relative(directory, path)).update("\0");
    hash.update(String(bytes.length)).update("\0").update(bytes).update("\0");
    let at = bytes.indexOf(placeholder);
    while (at !== -1) {
      matches.push({ path, bytes });
      at = bytes.indexOf(placeholder, at + placeholder.length);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      "Dashboard output must contain exactly one build digest placeholder."
    );
  }
  const digest = hash.digest("hex");
  const [{ path, bytes }] = matches;
  await writeFile(path, bytes.toString("utf-8").replace(placeholder, digest));
  const metadata = { revision, digest };
  await writeFile(
    resolve(directory, "build.json"),
    `${JSON.stringify(metadata)}\n`
  );
  return metadata;
}

export async function buildDashboard(): Promise<DashboardBuild> {
  const root = resolve(import.meta.dirname, "..");
  const revision = sourceRevision(
    process.env.BUILD_REVISION ?? process.env.GITHUB_SHA
  );
  const env = { ...process.env };
  if (revision === null) {
    delete env.BUILD_REVISION;
  } else {
    env.BUILD_REVISION = revision;
  }
  // Bun owns this script; Vite and Nitro keep their supported Node runtime.
  execFileSync("node", ["node_modules/vite/bin/vite.js", "build"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (sourceRevision() !== revision) {
    throw new Error("Source revision changed during the dashboard build.");
  }
  return await stampOutput(resolve(root, ".output"), revision);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const metadata = await buildDashboard();
  console.log(
    `Dashboard built: ${metadata.digest}; commit: ${
      metadata.revision ?? "uncommitted source"
    }.`
  );
}
