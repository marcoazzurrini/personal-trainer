import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { migrationStatements } from "./local.mjs";

let script, migrations;
const metadata = { revision: null, digest: "synthetic-runtime-build" };
before(async () => {
  const output = await build({
    entryPoints: [
      fileURLToPath(new URL("../../api/worker.ts", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: { __BUILD_METADATA__: JSON.stringify(metadata) },
    metafile: true,
  });
  assert.ok(
    !Object.keys(output.metafile.inputs).some((p) =>
      /api\/db\.ts|node_modules\/postgres\//.test(p)
    ),
  );
  script = output.outputFiles[0].text;
  assert.doesNotMatch(script, /Deno\.(?:env|serve|readTextFile)/);
  const directory = new URL("./migrations/", import.meta.url);
  migrations = migrationStatements((await Promise.all(
    (await readdir(directory))
      .filter((p) => p.endsWith(".sql")).sort().map((p) =>
        readFile(new URL(p, directory), "utf8")
      ),
  )).join("\n"));
});

async function fixture(t, { bindings = {}, onOutbound } = {}) {
  let outbound = 0;
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-08-03",
      d1Databases: { DB: `runtime-${randomUUID()}` },
      bindings: {
        ALLOWED_SUBJECT: "synthetic-owner",
        PUBLIC_ORIGIN: "https://trainer.invalid",
        AUTH_ISSUER: "https://identity.invalid",
        ...bindings,
      },
      outboundService(request) {
        outbound++;
        if (onOutbound) return onOutbound(request);
        throw new Error("No external services in runtime tests.");
      },
    }),
    cf: false,
    telemetry: { enabled: false },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await db.batch(migrations.map((sql) => db.prepare(sql)));
  const token = Buffer.from(randomUUID()).toString("base64url");
  await db.prepare(
    "INSERT INTO api_tokens (token_hash, subject, expires_at) VALUES (?, ?, ?)",
  ).bind(
    createHash("sha256").update(token).digest("hex"),
    "synthetic-owner",
    new Date(Date.now() + 3600000).toISOString().replace("Z", "000Z"),
  ).run();
  const request = (path, options = {}) =>
    mf.dispatchFetch(`https://trainer.invalid${path}`, options);
  const api = (path, options = {}) =>
    request(`/api${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  return { db, request, api, outbound: () => outbound };
}

test("the real Worker serves build-aware readiness without scheduling provider work", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/api/health");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "ok",
    revision: metadata.revision,
    build: metadata.digest,
  });
  assert.equal(f.outbound(), 0);
});

test("every documented operation remains behind authentication in the deployed entrypoint", async (t) => {
  const f = await fixture(t);
  const document = await (await f.request("/api/openapi.json")).json();
  let operations = 0;
  for (const [path, methods] of Object.entries(document.paths)) {
    for (
      const method of Object.keys(methods).filter((m) =>
        /^(get|post|put|patch|delete|head|options)$/.test(m)
      )
    ) {
      const response = await f.request(path.replace(/\{[^}]+\}/g, "1"), {
        method: method.toUpperCase(),
      });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      operations++;
    }
  }
  assert.ok(operations > 40, `Only ${operations} operations were checked.`);
  assert.equal(f.outbound(), 0);
});

test("the real Worker persists precise measurements and derived reads in its D1 binding", async (t) => {
  const f = await fixture(t);
  const response = await f.api("/bodyweight", {
    method: "POST",
    body: JSON.stringify({
      measured_at: "2026-08-10T06:30:00.123456Z",
      value_kg: 82.345,
      source: "manual",
      request_id: randomUUID(),
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const stored = await f.db.prepare(
    "SELECT value_kg, measured_at, measured_date FROM bodyweight",
  ).first();
  assert.equal(stored.value_kg, 8235);
  // The existing HTTP timestamp schema normalizes newly supplied values to
  // milliseconds. Imported values retain microseconds without this round trip.
  assert.equal(stored.measured_at, "2026-08-10T06:30:00.123000Z");
  assert.equal(stored.measured_date, "2026-08-10");
  const read = await f.api("/bodyweight");
  assert.equal(read.status, 200, await read.clone().text());
  assert.equal(read.headers.get("cache-control"), "private, no-store");
  assert.equal(f.outbound(), 0);
});

test("the real Worker identifies every GitHub request and relays refusals without retrying", async (t) => {
  let upstreamStatus = 200;
  const calls = [];
  const f = await fixture(t, {
    bindings: {
      GITHUB_TOKEN: "synthetic-github-token",
      GITHUB_REPO: "o/r",
      GITHUB_API_BASE: "https://github.invalid",
    },
    async onOutbound(request) {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://github.invalid");
      await request.text();
      calls.push({
        method: request.method,
        path: url.pathname,
        userAgent: request.headers.get("user-agent"),
        authorization: request.headers.get("authorization"),
      });
      if (!request.headers.get("user-agent") || upstreamStatus === 403) {
        return Response.json({ message: "Synthetic GitHub refusal" }, {
          status: 403,
        });
      }
      if (request.method === "GET") return Response.json([]);
      return Response.json({
        number: 7,
        html_url: "https://github.com/o/r/issues/7",
      }, { status: 201 });
    },
  });
  const operations = [
    { path: "/issues", options: {}, status: 200 },
    {
      path: "/issues",
      options: {
        method: "POST",
        body: JSON.stringify({
          kind: "bug",
          title: "Synthetic report",
          problem: "Synthetic failure",
          evidence: "Synthetic request returned an unexpected value.",
          request_id: randomUUID(),
        }),
      },
      status: 201,
    },
    {
      path: "/issues/7/comments",
      options: {
        method: "POST",
        body: JSON.stringify({ note: "Synthetic follow-up" }),
      },
      status: 201,
    },
  ];
  for (const operation of operations) {
    const before = calls.length;
    const response = await f.api(operation.path, operation.options);
    assert.equal(
      response.status,
      operation.status,
      await response.clone().text(),
    );
    await response.text();
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).userAgent, "personal-trainer");
    assert.equal(calls.at(-1).authorization, "Bearer synthetic-github-token");
  }
  upstreamStatus = 403;
  for (const operation of operations) {
    const before = calls.length;
    const response = await f.api(operation.path, operation.options);
    assert.equal(response.status, 502);
    assert.match(
      (await response.json()).error,
      /GitHub replied 403.*Synthetic GitHub refusal/,
    );
    assert.equal(
      calls.length,
      before + 1,
      "A refused GitHub write must not retry.",
    );
  }
  assert.equal(f.outbound(), 6);
});

test("token revocation takes effect without restarting the Worker", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api("/bodyweight")).status, 200);
  await f.db.prepare("DELETE FROM api_tokens").run();
  assert.equal((await f.api("/bodyweight")).status, 401);
});
