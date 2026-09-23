import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stopWorker, workerFixture } from "./worker-fixture.mts";

const origin = "https://dashboard.example.test";
const environment = {
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_API_KEY: "sk_test_synthetic",
  WORKOS_REDIRECT_URI: `${origin}/auth/callback`,
  WORKOS_COOKIE_PASSWORD:
    "synthetic-worker-cookie-secret-not-a-real-credential",
  ALLOWED_SUBJECT: "user_test",
  TRAINER_API_ORIGIN: "https://api.example.test",
  BUILD_REVISION: "b".repeat(40),
};

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }))).flat();
}

test("the Workers deployment is portable and contains no local credentials", async () => {
  const config = JSON.parse(
    await readFile(".output/server/wrangler.json", "utf8"),
  );
  assert.equal(config.main, "index.mjs");
  assert.equal(config.no_bundle, true);
  assert.ok(config.compatibility_flags.includes("nodejs_compat"));
  assert.equal(config.assets.binding, "ASSETS");
  assert.equal(config.assets.not_found_handling, "none");
  assert.deepEqual(config.assets.run_worker_first, [
    "/api/*",
    "/auth/*",
    "/_serverFn/*",
  ]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  for (
    const key of ["account_id", "d1_databases", "kv_namespaces", "hyperdrive"]
  ) {
    assert.equal(config[key], undefined);
  }
  const output = await files(".output");
  assert.ok(output.some((path) => path.endsWith("manifest.webmanifest")));
  assert.ok(
    !output.some((path) =>
      /(?:^|\/)\.env|\.dev\.vars|build-revision\.txt/.test(path)
    ),
  );
  for (const path of output.filter((path) => /\.(?:mjs|js|json)$/.test(path))) {
    const content = await readFile(path, "utf8");
    for (
      const value of [
        environment.WORKOS_API_KEY,
        environment.WORKOS_COOKIE_PASSWORD,
      ]
    ) {
      assert.ok(!content.includes(value), `${path} includes a runtime secret`);
    }
  }
});

test(
  "Wrangler packages the generated deployment without an account or network deployment",
  {
    timeout: 60_000,
  },
  async () => {
    const fixture = await workerFixture();
    let output = "";
    try {
      const child = fixture.spawn(["deploy", "--dry-run"]);
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const status = await new Promise((resolve) =>
        child.once("exit", resolve)
      );
      assert.equal(status, 0, output);
      assert.match(output, /dry.run/i);
    } finally {
      await fixture.dispose();
    }
  },
);

test(
  "workerd serves private server routes and fails closed on invalid configuration",
  {
    timeout: 60_000,
  },
  async (t) => {
    for (
      const redirect of [
        environment.WORKOS_REDIRECT_URI,
        "http://dashboard.example.test/auth/callback",
        "",
      ]
    ) {
      await t.test(redirect || "missing callback", async () => {
        const reservation = createServer();
        await new Promise((resolve) =>
          reservation.listen(0, "127.0.0.1", resolve)
        );
        const port = reservation.address().port;
        await new Promise((resolve) => reservation.close(resolve));
        const fixture = await workerFixture({
          ...environment,
          WORKOS_REDIRECT_URI: redirect,
        });
        const child = fixture.spawn([
          "dev",
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--inspector-port",
          "0",
          "--log-level",
          "error",
        ]);
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        const request = (path, method = "GET") =>
          fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            redirect: "manual",
          });
        try {
          let health;
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            try {
              health = await request("/api/health");
              break;
            } catch {
              await delay(100);
            }
          }
          assert.ok(health, output || "Worker did not start");
          assert.equal(
            health.headers.get("cache-control"),
            "private, no-store",
          );
          assert.equal(health.headers.get("set-cookie"), null);
          if (redirect !== environment.WORKOS_REDIRECT_URI) {
            assert.equal(health.status, 503);
            assert.equal((await request("/")).status, 503);
            return;
          }
          assert.equal(health.status, 200);
          const metadata = await health.json();
          assert.equal(metadata.status, "ok");
          const expected = JSON.parse(
            await readFile(".output/build.json", "utf8"),
          );
          assert.equal(metadata.revision, expected.revision);
          assert.equal(metadata.build, expected.digest);
          assert.match(metadata.build, /^[a-f0-9]{64}$/);
          assert.notEqual(metadata.revision, environment.BUILD_REVISION);
          const head = await request("/api/health", "HEAD");
          assert.equal(head.status, 200);
          assert.equal(await head.text(), "");
          assert.equal((await request("/api/health", "POST")).status, 405);
          const home = await request("/");
          assert.equal(home.status, 200);
          assert.equal(home.headers.get("cache-control"), "private, no-store");
          const html = await home.text();
          assert.match(html, /Sign in/);
          assert.ok(!html.includes(environment.WORKOS_API_KEY));
          assert.ok(!html.includes(environment.WORKOS_COOKIE_PASSWORD));
          const login = await request("/auth/sign-in");
          assert.ok([302, 303, 307].includes(login.status));
          assert.equal(login.headers.get("cache-control"), "private, no-store");
          const target = new URL(login.headers.get("location"));
          assert.equal(target.searchParams.get("client_id"), "client_test");
          assert.equal(target.searchParams.get("redirect_uri"), redirect);
          const manifest = await request("/manifest.webmanifest");
          assert.equal(manifest.status, 200);
          assert.equal(manifest.headers.get("set-cookie"), null);
          assert.equal((await manifest.json()).display, "standalone");
          const missing = await request("/not-a-dashboard-route");
          assert.equal(missing.status, 404);
          assert.equal(
            missing.headers.get("cache-control"),
            "private, no-store",
          );
        } finally {
          await stopWorker(child);
          await fixture.dispose();
        }
      });
    }
  },
);
