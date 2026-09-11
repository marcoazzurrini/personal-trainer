import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// No database, provider credentials, host environment file, or external runtime
// network is available to these containers. Each resource belongs to this run.
test("the standalone dashboard image serves its real revision", {
  timeout: 600_000,
}, async (t) => {
  const suffix = randomUUID();
  const image = `trainer-web-check:${suffix}`;
  const containers = [];
  const revision = "a".repeat(40);
  const fixture = `.env.container-${suffix}`;
  const origin = "https://dashboard.example.test";
  const environment = {
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "sk_test_synthetic",
    WORKOS_REDIRECT_URI: `${origin}/auth/callback`,
    WORKOS_COOKIE_PASSWORD:
      "synthetic-container-cookie-secret-not-a-real-credential",
    WORKOS_COOKIE_MAX_AGE: "604800",
    WORKOS_COOKIE_SAMESITE: "lax",
    ALLOWED_SUBJECT: "user_test",
    TRAINER_API_ORIGIN: "https://api.example.test",
    SOURCE_COMMIT: "b".repeat(40),
  };

  function docker(args, required = true) {
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (required && result.status !== 0) {
      throw new Error(
        `Docker ${args[0]} failed: ${
          (result.stderr || result.error?.message || "").slice(-2500)
        }`,
      );
    }
    return result;
  }

  function start(overrides = {}) {
    const name = `trainer-web-${containers.length}-${suffix}`;
    // Record before starting so a lost command response cannot orphan a container.
    containers.push(name);
    docker([
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      "trainer.web-container-test=true",
      "--network",
      "none",
      "--health-interval",
      "1s",
      "--health-start-period",
      "0s",
      ...Object.entries({ ...environment, ...overrides }).flatMap((
        [key, value],
      ) => ["--env", `${key}=${value}`]),
      image,
    ]);
    return name;
  }

  function evaluate(name, expression) {
    const result = docker([
      "exec",
      name,
      "node",
      "--input-type=module",
      "-e",
      `console.log(JSON.stringify(await (${expression})))`,
    ]);
    return JSON.parse(result.stdout);
  }

  function request(name, path = "/api/health", method = "GET") {
    return evaluate(
      name,
      `(async () => {
      const r = await fetch(${JSON.stringify(`http://127.0.0.1:3000${path}`)}, {
        method: ${JSON.stringify(method)}, redirect: "manual"
      });
      return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
    })()`,
    );
  }

  async function ready(name) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        return request(name);
      } catch {
        await delay(200);
      }
    }
    throw new Error("The isolated dashboard container did not start.");
  }

  t.after(() => {
    for (const name of containers) docker(["rm", "--force", name], false);
    docker(["image", "rm", "--force", image], false);
    try {
      unlinkSync(fixture);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });

  writeFileSync(
    fixture,
    "SYNTHETIC_CONTEXT_SECRET=must-not-enter-the-image\n",
    { flag: "wx", mode: 0o600 },
  );
  docker([
    "build",
    "--build-arg",
    `SOURCE_COMMIT=${revision}`,
    "--tag",
    image,
    ".",
  ]);
  const app = start();
  const health = await ready(app);

  await t.test("health names the built revision, not SOURCE_COMMIT at runtime", () => {
    assert.equal(health.status, 200);
    assert.equal(health.headers["cache-control"], "no-store");
    assert.equal(health.headers["set-cookie"], undefined);
    assert.deepEqual(JSON.parse(health.body), { status: "ok", revision });
    const head = request(app, "/api/health", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal(request(app, "/api/health", "POST").status, 405);
  });

  await t.test("the image excludes source, local environment files, and build dependencies", () => {
    const contents = evaluate(
      app,
      `(async () => {
      const fs = await import("node:fs");
      return { uid: process.getuid(), files: fs.readdirSync("/app"),
        fixtureExists: fs.existsSync(${JSON.stringify(`/app/${fixture}`)}),
        revisionOwner: fs.statSync("/app/.output/build-revision.txt").uid };
    })()`,
    );
    assert.notEqual(contents.uid, 0);
    assert.deepEqual(contents.files, [".output"]);
    assert.equal(contents.fixtureExists, false);
    assert.equal(contents.revisionOwner, 0);
  });

  await t.test("anonymous navigation and sign-in work behind HTTPS without network access", () => {
    const home = request(app, "/");
    assert.equal(home.status, 200);
    assert.match(home.body, /Sign in/);
    assert.ok(!home.body.includes(environment.WORKOS_API_KEY));
    assert.ok(!home.body.includes(environment.WORKOS_COOKIE_PASSWORD));
    const login = request(app, "/auth/sign-in");
    assert.ok([302, 303, 307].includes(login.status));
    const target = new URL(login.headers.location);
    assert.equal(target.searchParams.get("client_id"), "client_test");
    assert.equal(
      target.searchParams.get("redirect_uri"),
      environment.WORKOS_REDIRECT_URI,
    );
  });

  await t.test("Docker's own health check succeeds", async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const status = docker([
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        app,
      ]).stdout.trim();
      if (status === "healthy") return;
      await delay(250);
    }
    assert.fail("The image HEALTHCHECK did not become healthy.");
  });

  await t.test("invalid public configuration cannot report healthy", async () => {
    const invalid = start({
      WORKOS_REDIRECT_URI: "http://dashboard.example.test/auth/callback",
    });
    const response = await ready(invalid);
    assert.equal(response.status, 503);
    assert.ok(!response.body.includes(environment.WORKOS_API_KEY));
  });

  await t.test("missing and malformed source revisions refuse an image build", () => {
    for (const value of ["", "not-a-commit"]) {
      const result = docker([
        "build",
        "--build-arg",
        `SOURCE_COMMIT=${value}`,
        ".",
      ], false);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stdout + result.stderr,
        /SOURCE_COMMIT must identify the checked-out source/,
      );
    }
  });

  await t.test("SIGTERM stops the real entrypoint without a forced kill", () => {
    docker(["stop", "--time", "10", app]);
    const exit = Number(
      docker(["inspect", "--format", "{{.State.ExitCode}}", app]).stdout.trim(),
    );
    assert.ok([0, 143].includes(exit), `Unexpected shutdown exit ${exit}`);
  });
});
