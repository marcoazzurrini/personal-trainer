import assert from "node:assert/strict";
import test from "node:test";
import { sourceRevision } from "./build-worker.mjs";

const head = "a".repeat(40);
const git = (dirty = false) => (...args) => {
  assert.ok(["rev-parse", "status"].includes(args[0]));
  return args[0] === "rev-parse" ? head : dirty ? " M api/worker.ts" : "";
};

test("a clean checkout can claim only its actual commit", () => {
  assert.equal(sourceRevision(head, git()), head);
  assert.equal(sourceRevision(null, git()), head);
  for (const expected of ["wrong", "b".repeat(40)]) {
    assert.throws(
      () => sourceRevision(expected, git()),
      /exact clean GITHUB_SHA/,
    );
  }
});

test("a dirty checkout cannot be relabelled as the CI commit", () => {
  assert.equal(sourceRevision(null, git(true)), null);
  assert.throws(
    () => sourceRevision(head, git(true)),
    /exact clean GITHUB_SHA/,
  );
});
