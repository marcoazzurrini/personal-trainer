import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface Step {
  name?: string;
  run?: string;
}
interface Job {
  needs?: string[];
  if?: string;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  steps: Step[];
}

// SAFETY: ci.yml is this repository's own workflow, and GitHub refuses to run
// one whose jobs are not a map of steps.
const workflow = Bun.YAML.parse(
  await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf-8"
  )
) as { jobs: Record<string, Job> };

// A release changes production in an order that a rollback cannot undo:
// migrations first, then the API, then the dashboard. Each later step must
// wait for proof that the earlier one is live.
test("production changes only after every check, once, in a safe order", () => {
  const { deploy } = workflow.jobs;
  assert.deepEqual(deploy.needs?.toSorted(), ["checks", "d1", "test", "web"]);
  assert.match(deploy.if ?? "", /github\.ref == 'refs\/heads\/main'/u);
  assert.match(deploy.if ?? "", /github\.event_name != 'pull_request'/u);
  assert.equal(deploy.concurrency?.["cancel-in-progress"], false);

  const position = (pattern: RegExp) => {
    const index = deploy.steps.findIndex((step) =>
      pattern.test(`${step.name ?? ""}\n${step.run ?? ""}`)
    );
    assert.notEqual(index, -1, `The release has no step matching ${pattern}.`);
    return index;
  };
  const order = [
    position(/run --cwd apps\/web build/u),
    position(/db:migrate:remote/u),
    position(/--cwd apps\/api deploy .*__BUILD_REVISION__/u),
    position(/Wait for the API/u),
    position(/run --cwd apps\/web deploy/u),
    position(/Wait for the dashboard/u),
  ];
  assert.deepEqual(
    order,
    order.toSorted((a, b) => a - b)
  );
});

test("a release waits for health to report the exact commit", () => {
  const waits = workflow.jobs.deploy.steps.filter((step) =>
    step.name?.startsWith("Wait for")
  );
  assert.equal(waits.length, 2);
  for (const step of waits) {
    assert.match(step.run ?? "", /\.revision == \$sha/u);
    assert.match(step.run ?? "", /exit 1/u);
  }
});
