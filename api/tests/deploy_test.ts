import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { verifyRelease } from "../../scripts/deploy-worker.mjs";
import { assert, assertEquals, assertRejects } from "./assertions.ts";

const expected = { revision: "a".repeat(40), digest: "b".repeat(64) };
const endpoint = "https://trainer.example/api/health";
const healthy = {
  status: "ok",
  revision: expected.revision,
  build: expected.digest,
};
interface HealthReply {
  status: string;
  revision: string;
  build?: string;
}
const reply = (body: HealthReply, headers?: HeadersInit) =>
  Response.json(body, { headers: headers ?? { "Cache-Control": "no-store" } });
test("Worker release verification refuses old, cached or unready public builds", async () => {
  for (const fetcher of [
    () => reply({ ...healthy, build: "old" }),
    () => reply({ ...healthy, revision: "c".repeat(40) }),
    () => reply({ status: "ok", revision: expected.revision }),
    () => reply({ ...healthy, status: "unhealthy" }),
    () => reply(healthy, { "Cache-Control": "public, max-age=60" }),
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 302 }),
    () => new Response("not JSON"),
    () => {
      throw new Error("Synthetic network failure");
    },
  ]) {
    await assertRejects(
      () => verifyRelease(endpoint, expected, { attempts: 1, fetcher }),
      Error,
      "migrations may already have changed production"
    );
  }
});
test("Worker release verification retries bounded uncached probes for the exact artifact", async () => {
  const probes: string[] = [];
  const sleeps: number[] = [];
  await verifyRelease(endpoint, expected, {
    attempts: 2,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    fetcher: (url: URL, options: RequestInit) => {
      assertEquals(url.origin + url.pathname, endpoint);
      const probe = url.searchParams.get("release_probe");
      assert(probe);
      probes.push(probe);
      assertEquals(options.redirect, "error");
      assertEquals(
        new Headers(options.headers).get("Cache-Control"),
        "no-cache"
      );
      assertEquals(new Headers(options.headers).get("Authorization"), null);
      assert(options.signal instanceof AbortSignal);
      return probes.length === 1
        ? new Response(null, { status: 503 })
        : reply(healthy);
    },
  });
  assertEquals(probes.length, 2);
  assert(probes[0] !== probes[1]);
  assertEquals(sleeps, [5000]);
});
test("Worker release verification refuses cleartext without a request", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      verifyRelease("http://trainer.example/api/health", expected, {
        fetcher: () => {
          calls += 1;
          return reply(healthy);
        },
      }),
    Error,
    "requires HTTPS"
  );
  assertEquals(calls, 0);
});
test("API release applies migrations and verifies the deployed immutable artifact", async () => {
  const source = await readFile("scripts/deploy-worker.mjs", "utf-8");
  const steps = [
    "await buildWorker()",
    'run(["d1", "migrations", "apply", "personal-trainer", "--remote"])',
    'run(["deploy", "--no-bundle"',
    "built.digest !== metadata.digest || built.revision !== metadata.revision",
    "await verifyRelease(health, metadata)",
  ];
  let previous = -1;
  for (const step of steps) {
    const index = source
      .replaceAll(/\s+/gu, "")
      .indexOf(step.replaceAll(/\s+/gu, ""));
    assert(index > previous, `Release must run ${step} in order.`);
    previous = index;
  }
});
test("CI gates a serialized Workers release on isolated API, D1, browser and Worker tests", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf-8");
  const job = (name: string) => {
    const body = workflow
      .split(`\n  ${name}:\n`)[1]
      ?.split(/\n {2}[a-z]+:\n/u)[0];
    assert(body, `Missing ${name} job.`);
    assert(!body.includes("continue-on-error"));
    return body;
  };
  const checks = job("checks");
  assert(checks.includes("run: bun run secrets"));
  assert(checks.includes("run: bun run test:secrets"));
  assert(checks.includes("run: bun run check:style"));
  assert(checks.includes("run: bun run test:tooling"));
  const api = job("test");
  for (const body of [checks, api]) {
    assert(body.includes("uses: actions/setup-node@"));
    assert(body.includes("uses: oven-sh/setup-bun@"));
    assert(body.includes("run: bun install --frozen-lockfile\n"));
  }
  const install = api.indexOf("run: bun install --frozen-lockfile");
  assert(install !== -1 && install < api.indexOf("run: bun run test:api"));
  assert(api.includes("run: bun run test:shutdown"));
  assert(!workflow.includes("coverage"));
  assert(!workflow.includes("upload-artifact"));
  assert(!workflow.includes("COOLIFY"));
  assert(!workflow.includes("test:container"));
  const d1 = job("d1");
  let installed = -1;
  for (const step of [
    "run: bun install --frozen-lockfile\n",
    "run: bun run test:d1",
  ]) {
    const index = d1.indexOf(step);
    assert(index > installed, `D1 tests require ${step} in order.`);
    installed = index;
  }
  assert(d1.includes("run: bun run test:postgres-import"));
  assert(!d1.includes("--remote"));
  const web = job("web");
  for (const command of [
    "bun install --frozen-lockfile",
    "bun run --cwd web build",
    "bun run --cwd web check",
    "bun run --cwd web test",
    "bun run --cwd web test:browser",
    "bun run --cwd web test:workers",
  ]) {
    assert(web.includes(`run: ${command}`), `Web gate is missing ${command}.`);
  }
  assert(!web.includes("secrets.WORKOS"));
  const release = job("deploy");
  for (const contract of [
    "needs: [checks, test, d1, web]",
    "github.event_name != 'pull_request'",
    "github.ref == 'refs/heads/main'",
    "group: deploy",
    "cancel-in-progress: false",
    "timeout-minutes: 35",
    // oxlint-disable-next-line eslint/no-template-curly-in-string -- This is literal GitHub Actions syntax, not JavaScript interpolation.
    "ref: ${{ github.sha }}",
    "secrets.CLOUDFLARE_API_TOKEN",
    "secrets.CLOUDFLARE_ACCOUNT_ID",
    "if (!process.env[key]?.trim()) throw new Error",
    "sourceRevision(process.env.GITHUB_SHA)",
    "metadata.revision !== process.env.GITHUB_SHA",
    "metadata.digest",
    "web/.output/build.json",
    "await verifyRelease(process.env.DASHBOARD_HEALTH_URL, metadata)",
  ]) {
    assert(release.includes(contract), `Release is missing ${contract}.`);
  }
  assertEquals([...release.matchAll(/^\s+if:/gmu)].length, 1);
  let previous = -1;
  for (const step of [
    "name: Validate both release configurations",
    "run: bun run --cwd web build",
    "name: Validate dashboard build identity",
    "run: bun run deploy",
    "run: bun run --cwd web deploy",
    "await verifyRelease(process.env.DASHBOARD_HEALTH_URL, metadata)",
  ]) {
    const index = release.indexOf(step);
    assert(index > previous, `Release must run ${step} in order.`);
    previous = index;
  }
});
