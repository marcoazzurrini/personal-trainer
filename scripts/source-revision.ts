import { execFileSync } from "node:child_process";
import nodePath from "node:path";

const root = nodePath.resolve(import.meta.dirname, "..");

export function sourceRevision(
  expected: string | null | undefined = process.env.GITHUB_SHA,
  git: (...args: string[]) => string = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim()
) {
  const head = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--untracked-files=normal") !== "";
  if (
    expected &&
    (!/^[a-f0-9]{40}$/u.test(expected) || expected !== head || dirty)
  ) {
    throw new Error(
      "A release build requires the exact clean GITHUB_SHA checkout. No artifact was labelled with that revision."
    );
  }
  return dirty ? null : head;
}
