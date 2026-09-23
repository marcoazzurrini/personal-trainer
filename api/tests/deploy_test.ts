import { assert, assertEquals, assertRejects } from "@std/assert";
import { verifyRelease } from "../../scripts/deploy-worker.mjs";

const expected = { revision: "a".repeat(40), digest: "b".repeat(64) };
const endpoint = "https://trainer.example/api/health";
const healthy = {
  status: "ok",
  revision: expected.revision,
  build: expected.digest,
};
const reply = (body: unknown, headers = { "Cache-Control": "no-store" }) =>
  Response.json(body, { headers });

Deno.test("Worker release verification refuses old, cached or unready public builds", async () => {
  for (
    const fetcher of [
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
    ]
  ) {
    await assertRejects(
      () => verifyRelease(endpoint, expected, { attempts: 1, fetcher }),
      Error,
      "migrations may already have changed production",
    );
  }
});

Deno.test("Worker release verification retries bounded uncached probes for the exact artifact", async () => {
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
        "no-cache",
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

Deno.test("Worker release verification refuses cleartext without a request", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      verifyRelease("http://trainer.example/api/health", expected, {
        fetcher: () => {
          calls++;
          return reply(healthy);
        },
      }),
    Error,
    "requires HTTPS",
  );
  assertEquals(calls, 0);
});

Deno.test("API release applies migrations and verifies the deployed immutable artifact", async () => {
  const source = await Deno.readTextFile("scripts/deploy-worker.mjs");
  const steps = [
    "await buildWorker()",
    'run(["d1", "migrations", "apply", "personal-trainer", "--remote"])',
    'run(["deploy", "--no-bundle"',
    "built.digest !== metadata.digest || built.revision !== metadata.revision",
    "await verifyRelease(health, metadata)",
  ];
  let previous = -1;
  for (const step of steps) {
    const index = source.replace(/\s+/g, "").indexOf(step.replace(/\s+/g, ""));
    assert(index > previous, `Release must run ${step} in order.`);
    previous = index;
  }
});

Deno.test("CI gates a serialized Workers release on isolated API, D1, browser and Worker tests", async () => {
  const workflow = await Deno.readTextFile(".github/workflows/ci.yml");
  const job = (name: string) => {
    const body = workflow.split(`\n  ${name}:\n`)[1]?.split(
      /\n {2}[a-z]+:\n/,
    )[0];
    assert(body, `Missing ${name} job.`);
    assert(!body.includes("continue-on-error"));
    return body;
  };
  const checks = job("checks");
  assert(checks.includes("run: deno task secrets"));
  assert(checks.includes("run: deno task test:secrets"));
  assert(checks.includes("run: npm run test:tooling"));
  const api = job("test");
  for (const body of [checks, api]) {
    assert(body.includes("uses: actions/setup-node@"));
    assert(body.includes("uses: denoland/setup-deno@"));
    assert(body.includes("run: npm ci\n"));
  }
  const prepare = api.indexOf("run: npm run test:prepare");
  assert(prepare >= 0 && prepare < api.indexOf("run: npm run test:api"));
  assert(api.includes("run: npm run test:shutdown"));
  assert(!workflow.includes("coverage"));
  assert(!workflow.includes("upload-artifact"));
  assert(!workflow.includes("COOLIFY"));
  assert(!workflow.includes("test:container"));
  const d1 = job("d1");
  let installed = -1;
  for (
    const step of [
      "run: npm ci\n",
      "run: npm ci --ignore-scripts --prefix db/d1",
      "run: npm test --prefix db/d1",
    ]
  ) {
    const index = d1.indexOf(step);
    assert(index > installed, `D1 tests require ${step} in order.`);
    installed = index;
  }
  assert(d1.includes("run: npm --prefix db/d1 run test:postgres"));
  assert(!d1.includes("--remote"));
  const web = job("web");
  for (
    const command of [
      "npm ci --prefix web",
      "npm --prefix web run build",
      "npm --prefix web run check",
      "npm --prefix web test",
      "npm --prefix web run test:browser",
      "npm --prefix web run test:workers",
    ]
  ) assert(web.includes(`run: ${command}`), `Web gate is missing ${command}.`);
  assert(!web.includes("secrets.WORKOS"));
  const release = job("deploy");
  for (
    const contract of [
      "needs: [checks, test, d1, web]",
      "github.event_name != 'pull_request'",
      "github.ref == 'refs/heads/main'",
      "group: deploy",
      "cancel-in-progress: false",
      "timeout-minutes: 35",
      "ref: ${{ github.sha }}",
      "secrets.CLOUDFLARE_API_TOKEN",
      "secrets.CLOUDFLARE_ACCOUNT_ID",
      "if (!process.env[key]?.trim()) throw new Error",
      "sourceRevision(process.env.GITHUB_SHA)",
      "metadata.revision !== process.env.GITHUB_SHA",
      "metadata.digest",
      "web/.output/build.json",
      "await verifyRelease(process.env.DASHBOARD_HEALTH_URL, metadata)",
    ]
  ) assert(release.includes(contract), `Release is missing ${contract}.`);
  assertEquals([...release.matchAll(/^\s+if:/gm)].length, 1);
  let previous = -1;
  for (
    const step of [
      "name: Validate both release configurations",
      "run: npm --prefix web run build",
      "name: Validate dashboard build identity",
      "run: npm run deploy",
      "run: npm --prefix web run deploy",
      "await verifyRelease(process.env.DASHBOARD_HEALTH_URL, metadata)",
    ]
  ) {
    const index = release.indexOf(step);
    assert(index > previous, `Release must run ${step} in order.`);
    previous = index;
  }
});
