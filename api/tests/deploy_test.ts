import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { deploy, deploymentConfig } from "../../scripts/deploy.ts";

const sha = "a".repeat(40);
const other = "b".repeat(40);
const env = {
  COOLIFY_WEBHOOK:
    "https://coolify.example/api/v1/deploy?uuid=application&force=false",
  COOLIFY_TOKEN: "synthetic-private-token",
  GITHUB_SHA: sha,
  GITHUB_REPOSITORY: "owner/repo",
  DEPLOY_HEALTH_URL: "https://trainer.example/api/health",
};

function fixture() {
  let clock = 0;
  const config = deploymentConfig(env);
  const calls: { url: string; method: string; body: unknown }[] = [];
  const application = {
    uuid: "application",
    git_repository: "owner/repo",
    git_branch: "main",
    git_commit_sha: "HEAD",
    build_pack: "dockerfile",
    settings: {
      is_auto_deploy_enabled: false,
      is_preview_deployments_enabled: false,
      include_source_commit_in_build: true,
      inject_build_args_to_dockerfile: true,
      use_build_secrets: false,
    },
  };
  const accepted = {
    deployments: [{
      resource_uuid: "application",
      deployment_uuid: "deployment",
    }],
  };
  const deployment = {
    deployment_uuid: "deployment",
    commit: sha,
    status: "finished",
  };
  const health = { status: "ok", revision: sha };
  let before: (url: string, method: string) => Response | undefined = () =>
    undefined;
  // The fetch double preserves asynchronous rejection for synchronous assertions.
  // deno-lint-ignore require-await
  const send: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    assertEquals(init?.redirect, "error");
    assert(init?.signal instanceof AbortSignal);
    if (url.startsWith(config.origin)) {
      assertEquals(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${env.COOLIFY_TOKEN}`,
      );
    } else {
      assertEquals(new Headers(init?.headers).get("authorization"), null);
      assertEquals(init?.cache, "no-store");
    }
    const response = before(url, method);
    if (response) return response;
    if (url.endsWith("/applications/application")) {
      if (method === "PATCH") application.git_commit_sha = body.git_commit_sha;
      return Response.json(application);
    }
    if (url.endsWith("/deploy")) return Response.json(accepted);
    if (url.endsWith("/deployments/deployment")) {
      return Response.json(deployment);
    }
    if (url === config.healthUrl) return Response.json(health);
    throw new Error("Unexpected request");
  };
  return {
    config,
    calls,
    application,
    accepted,
    deployment,
    health,
    before: (hook: typeof before) => {
      before = hook;
    },
    run: () =>
      deploy(config, {
        fetch: send,
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
        timeoutMs: 12_000,
      }),
  };
}

Deno.test("deployment refuses missing configuration and unsafe selectors before any request", () => {
  for (const key of Object.keys(env)) {
    assertThrows(() => deploymentConfig({ ...env, [key]: "" }), Error, key);
  }
  for (
    const url of [
      "http://coolify.example/api/v1/deploy?uuid=application",
      "https://user:secret@coolify.example/api/v1/deploy?uuid=application",
      "https://coolify.example/api/v1/deploy?tag=all",
      "https://coolify.example/api/v1/deploy?uuid=a&uuid=b",
      "https://coolify.example/api/v1/deploy?uuid=a&pr=1",
      "https://coolify.example/api/v1/deploy?uuid=a,b",
      "https://coolify.example/wrong?uuid=a",
    ]
  ) assertThrows(() => deploymentConfig({ ...env, COOLIFY_WEBHOOK: url }));
  for (const bad of ["HEAD", "a".repeat(7), sha.toUpperCase()]) {
    assertThrows(() => deploymentConfig({ ...env, GITHUB_SHA: bad }));
  }
});

Deno.test("deployment pins before queueing and checks completion before public revision health", async () => {
  const f = fixture();
  assertEquals(await f.run(), "deployment");
  assertEquals(f.calls.map((c) => [c.method, new URL(c.url).pathname]), [
    ["GET", "/api/v1/applications/application"],
    ["PATCH", "/api/v1/applications/application"],
    ["GET", "/api/v1/applications/application"],
    ["POST", "/api/v1/deploy"],
    ["GET", "/api/v1/deployments/deployment"],
    ["GET", "/api/health"],
  ]);
  assertEquals(f.calls[1].body, { git_commit_sha: sha });
  assertEquals(f.calls[3].body, { uuid: "application", force: true });
});

Deno.test("unverified hosted settings and wrong source refuse before changing anything", async () => {
  for (const key of Object.keys(fixture().application.settings)) {
    const f = fixture();
    const settings = f.application.settings as Record<string, boolean>;
    settings[key] = !settings[key];
    await assertRejects(f.run, Error, "Verify Coolify settings");
    assertEquals(f.calls.length, 1);
  }
  const f = fixture();
  f.application.git_repository = "someone/else";
  await assertRejects(f.run, Error, "this repository");
  assertEquals(f.calls.length, 1);
});

Deno.test("a lost application pin never queues a deployment", async () => {
  const f = fixture();
  f.before((_url, method) =>
    method === "PATCH" ? Response.json({}) : undefined
  );
  await assertRejects(f.run, Error, "did not retain");
  assert(!f.calls.some((c) => c.method === "POST"));
});

Deno.test("webhook acceptance alone is not success; queued work must finish", async () => {
  const f = fixture();
  f.deployment.status = "queued";
  await assertRejects(f.run, Error, "timed out");
  assert(!f.calls.some((c) => c.url === f.config.healthUrl));
  assertEquals(f.calls.filter((c) => c.method === "POST").length, 1);
});

Deno.test("a queue pins A even if the branch moves to B; a different queued commit fails", async () => {
  const f = fixture();
  let polls = 0;
  f.before((url) => {
    if (url.endsWith("/deployments/deployment")) {
      f.application.git_commit_sha = other;
      f.deployment.status = ++polls === 1 ? "in_progress" : "finished";
    }
    return undefined;
  });
  assertEquals(await f.run(), "deployment");
  for (const commit of [other, "HEAD"]) {
    const mismatch = fixture();
    mismatch.deployment.commit = commit;
    await assertRejects(mismatch.run, Error, "exact tested commit");
    assert(!mismatch.calls.some((c) => c.url === mismatch.config.healthUrl));
  }
});

Deno.test("failed, cancelled, and unknown deployment states cannot pass", async () => {
  for (const status of ["failed", "cancelled", "unknown"]) {
    const f = fixture();
    f.deployment.status = status;
    await assertRejects(f.run, Error, "failed, was cancelled");
  }
});

Deno.test("missing or mismatched deployment IDs fail closed", async () => {
  for (const field of ["deployment_uuid", "resource_uuid"] as const) {
    const f = fixture();
    f.accepted.deployments[0][field] = "";
    await assertRejects(f.run, Error, "deployment ID");
  }
  const f = fixture();
  f.accepted.deployments = [];
  await assertRejects(f.run, Error, "exactly one");
  const mismatch = fixture();
  mismatch.deployment.deployment_uuid = "different";
  await assertRejects(mismatch.run, Error, "exact tested commit");
});

Deno.test("only the expected healthy public revision passes, not the old healthy container", async () => {
  for (const revision of [other, "", "HEAD"]) {
    const f = fixture();
    f.health.revision = revision;
    await assertRejects(f.run, Error, "timed out");
  }
  for (const status of [503, 302]) {
    const f = fixture();
    f.before((url) =>
      url === f.config.healthUrl ? new Response(null, { status }) : undefined
    );
    await assertRejects(f.run, Error, "timed out");
  }
  const f = fixture();
  f.health.status = "unhealthy";
  await assertRejects(f.run, Error, "timed out");
  const rolling = fixture();
  let polls = 0;
  rolling.before((url) => {
    if (url === rolling.config.healthUrl) {
      rolling.health.revision = ++polls === 1 ? other : sha;
    }
    return undefined;
  });
  assertEquals(await rolling.run(), "deployment");
});

Deno.test("control API errors are redacted and writes with unknown outcomes are not retried", async () => {
  for (const method of ["GET", "PATCH", "POST"]) {
    const f = fixture();
    f.before((_url, sent) =>
      sent === method
        ? new Response(env.COOLIFY_TOKEN, { status: 403 })
        : undefined
    );
    const error = await assertRejects(f.run, Error);
    assert(!error.message.includes(env.COOLIFY_TOKEN));
    assertEquals(f.calls.filter((c) => c.method === method).length, 1);
  }
  const f = fixture();
  f.before(() => new Response(env.COOLIFY_TOKEN));
  const error = await assertRejects(f.run, Error);
  assert(!error.message.includes(env.COOLIFY_TOKEN));
});

Deno.test("a stalled response body is bounded, not only its headers", async () => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        }),
      );
    },
  );
  try {
    const start = performance.now();
    await assertRejects(
      () =>
        deploy({
          ...deploymentConfig(env),
          origin: `http://127.0.0.1:${server.addr.port}`,
        }, { timeoutMs: 100 }),
      Error,
      "Coolify GET failed",
    );
    assert(performance.now() - start < 2000);
  } finally {
    await server.shutdown();
  }
});

Deno.test("main CI cannot skip deployment for missing secrets or stop at webhook acceptance", async () => {
  const workflow = await Deno.readTextFile(".github/workflows/ci.yml");
  const job = workflow.split("\n  deploy:\n")[1];
  assert(job);
  assert(job.includes("needs: [checks, test, web]"));
  const webJob = workflow.split("\n  web:\n")[1]?.split("\n  deploy:\n")[0];
  assert(webJob);
  for (
    const command of [
      "npm ci --prefix web",
      "npm --prefix web run build",
      "npm --prefix web run check",
      "npm --prefix web test",
      "npm --prefix web run test:browser",
    ]
  ) {
    assert(
      webJob.includes(`run: ${command}`),
      `Web gate is missing ${command}`,
    );
  }
  assert(!webJob.includes("continue-on-error"));
  assert(!webJob.includes("secrets.WORKOS"));
  assert(job.includes("github.event_name != 'pull_request'"));
  assert(job.includes("github.ref == 'refs/heads/main'"));
  assert(job.includes("group: deploy"));
  assert(job.includes("cancel-in-progress: false"));
  assert(job.includes("timeout-minutes: 20"));
  assert(job.includes("run: deno task deploy"));
  assertEquals([...job.matchAll(/^\s+if:/gm)].length, 1);
  assert(!job.includes("if: env.COOLIFY"));
  assert(!job.includes("continue-on-error"));
  assert(!job.includes("curl"));
});
