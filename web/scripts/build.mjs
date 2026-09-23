import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceRevision } from "../../scripts/source-revision.mjs";

export const placeholder = "__TRAINER_WEB_BUILD_DIGEST_PLACEHOLDER__";

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }))).flat().sort();
}

/** Hash the complete compiler output before stamping its single placeholder. */
export async function stampOutput(directory, revision) {
  const hash = createHash("sha256");
  const matches = [];
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
      "Dashboard output must contain exactly one build digest placeholder.",
    );
  }
  const digest = hash.digest("hex");
  const [{ path, bytes }] = matches;
  await writeFile(path, bytes.toString("utf8").replace(placeholder, digest));
  const metadata = { revision, digest };
  await writeFile(
    resolve(directory, "build.json"),
    JSON.stringify(metadata) + "\n",
  );
  return metadata;
}

export async function buildDashboard() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const revision = sourceRevision(
    process.env.BUILD_REVISION ?? process.env.GITHUB_SHA,
  );
  const env = { ...process.env };
  if (revision === null) delete env.BUILD_REVISION;
  else env.BUILD_REVISION = revision;
  execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (sourceRevision() !== revision) {
    throw new Error("Source revision changed during the dashboard build.");
  }
  return await stampOutput(resolve(root, ".output"), revision);
}

if (
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const metadata = await buildDashboard();
  console.log(
    `Dashboard built: ${metadata.digest}; commit: ${
      metadata.revision ?? "uncommitted source"
    }.`,
  );
}
