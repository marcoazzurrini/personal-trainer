import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function sourceRevision(
  expected = process.env.GITHUB_SHA,
  git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(),
) {
  const head = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--untracked-files=normal") !== "";
  if (
    expected && (!/^[a-f0-9]{40}$/.test(expected) || expected !== head || dirty)
  ) {
    throw new Error(
      "A release build requires the exact clean GITHUB_SHA checkout. No artifact was labelled with that revision.",
    );
  }
  return dirty ? null : head;
}
