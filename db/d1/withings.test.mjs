import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { migrationStatements } from "./local.mjs";

let script, migrations;
const epoch = (iso) => Date.parse(iso) / 1000;
const providerTime = epoch("2026-08-29T11:00:00Z");
const group = (extra = {}) => ({
  grpid: 1,
  date: epoch("2026-08-28T10:00:00Z"),
  category: 1,
  attrib: 0,
  deviceid: "synthetic-scale",
  measures: [{ type: 1, value: 72655, unit: -3 }],
  ...extra,
});
const measures = (groups = [group()], updatetime = providerTime) => ({
  status: 0,
  body: { updatetime, measuregrps: groups },
});
const rotated = {
  status: 0,
  body: {
    access_token: "fake-new-access",
    refresh_token: "fake-new-refresh",
    expires_in: 3600,
  },
};
before(async () => {
  const compiled = await build({
    entryPoints: [
      fileURLToPath(new URL("./withings.test.worker.ts", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
  });
  assert.ok(
    !Object.keys(compiled.metafile.inputs).some((p) =>
      /api\/db\.ts|postgres/.test(p)
    ),
  );
  script = compiled.outputFiles[0].text;
  assert.doesNotMatch(script, /Deno\./);
  const dir = new URL("./migrations/", import.meta.url);
  migrations = migrationStatements(
    (
      await Promise.all(
        (await readdir(dir))
          .filter((p) => p.endsWith(".sql"))
          .sort()
          .map((p) => readFile(new URL(p, dir), "utf8")),
      )
    ).join("\n"),
  );
});
async function fixture(t, { expired = false, seed = true } = {}) {
  const requests = [],
    replies = [];
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-08-03",
      d1Databases: { DB: randomUUID() },
      async outboundService(request) {
        assert.equal(
          new URL(request.url).origin,
          "https://withings.invalid",
          "No real provider is reachable",
        );
        requests.push({
          url: request.url,
          form: new URLSearchParams(await request.text()),
          authorization: request.headers.get("authorization"),
        });
        assert.ok(replies.length, "Unexpected provider call");
        const reply = replies.shift();
        return Response.json(
          typeof reply === "function" ? await reply(requests.at(-1)) : reply,
        );
      },
    }),
    cf: false,
    telemetry: { enabled: false },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await db.batch(migrations.map((sql) => db.prepare(sql)));
  if (seed) {
    await db
      .prepare(
        `INSERT INTO withings_auth (withings_user_id, access_token, refresh_token, access_token_expires_at)
    VALUES ('owner', 'fake-access', 'fake-refresh', ?)`,
      )
      .bind(
        expired ? "2026-08-29T00:00:00.000000Z" : "2026-09-01T00:00:00.000000Z",
      )
      .run();
  }
  const call = (path, options = {}) =>
    mf.dispatchFetch(`https://local.invalid${path}`, options);
  async function store(method, args = [], now) {
    const response = await call("/store", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(now ? { "x-clock": now } : {}),
      },
      body: JSON.stringify({ method, args }),
    });
    return { status: response.status, body: await response.json() };
  }
  const auth = () => db.prepare("SELECT * FROM withings_auth").first();
  const weights = async () =>
    (await db.prepare("SELECT * FROM bodyweight ORDER BY id").all()).results;
  return { db, call, store, auth, weights, requests, replies };
}
async function eventually(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("waitUntil work did not finish");
}

test("Withings import preserves provider watermark, scaling, refusal and dedup across requests", async (t) => {
  const f = await fixture(t);
  f.replies.push(
    measures([
      group(),
      group({ grpid: 2, category: 2 }),
      group({
        grpid: 3,
        date: epoch("2026-08-28T11:00:00Z"),
        measures: [{ type: 1, value: 2, unit: 0 }],
      }),
    ]),
  );
  const first = await f.store("catchUp");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, {
    range: "since 0",
    fetched: 3,
    ignored: 1,
    written: 1,
    duplicate: 0,
    refused: 1,
  });
  assert.equal((await f.weights())[0].value_kg, 7266);
  assert.equal((await f.auth()).last_sync_at, "2026-08-29T11:00:00.000000Z");
  f.replies.push(measures());
  assert.equal((await f.store("catchUp")).body.duplicate, 1);
  assert.equal(f.requests[1].form.get("lastupdate"), String(providerTime));
  assert.equal(f.requests[1].authorization, "Bearer fake-access");
  f.replies.push(measures([], providerTime - 100));
  await f.store("catchUp", [0]);
  assert.equal(f.requests[2].form.get("lastupdate"), "0");
  assert.equal(
    (await f.auth()).last_sync_at,
    "2026-08-29T11:00:00.000000Z",
    "Watermark never regresses",
  );
});

test("interrupted writes leave checkpoint unchanged and replay deduplicates prior facts", async (t) => {
  const f = await fixture(t);
  await f.db
    .prepare(
      `CREATE TRIGGER synthetic_write_failure BEFORE INSERT ON bodyweight
    WHEN NEW.value_kg = 8000 BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END`,
    )
    .run();
  const groups = [
    group(),
    group({
      grpid: 2,
      date: epoch("2026-08-28T11:00:00Z"),
      measures: [{ type: 1, value: 80, unit: 0 }],
    }),
  ];
  f.replies.push(measures(groups));
  assert.equal((await f.store("catchUp")).status, 500);
  assert.equal((await f.weights()).length, 1);
  assert.equal((await f.auth()).last_sync_at, null);
  await f.db.prepare("DROP TRIGGER synthetic_write_failure").run();
  f.replies.push(measures(groups));
  const replay = await f.store("catchUp");
  assert.equal(replay.status, 200);
  assert.equal(replay.body.written, 1);
  assert.equal(replay.body.duplicate, 1);
  assert.equal((await f.weights()).length, 2);
  assert.equal((await f.auth()).last_sync_at, "2026-08-29T11:00:00.000000Z");
});

test("notification window widens 60 seconds and never advances catch-up watermark", async (t) => {
  const f = await fixture(t);
  f.replies.push(measures());
  assert.equal(
    (await f.store("syncNotifiedWindow", [1000, 2000, "owner"])).status,
    200,
  );
  assert.equal(f.requests[0].form.get("startdate"), "940");
  assert.equal(f.requests[0].form.get("enddate"), "2060");
  assert.equal((await f.auth()).last_sync_at, null);
  assert.equal(
    (await f.store("syncNotifiedWindow", [1000, 2000, "other"])).status,
    500,
  );
  assert.equal(f.requests.length, 1);
});

test("DB schedule claim admits one concurrent request; throttle persists after failures", async (t) => {
  const f = await fixture(t);
  f.replies.push(measures([]));
  const results = await Promise.all(
    Array.from({ length: 5 }, () => f.store("catchUpIfDue")),
  );
  assert.equal(results.filter((r) => r.body !== null).length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(
    (await f.auth()).last_sync_attempt_at,
    "2026-08-30T12:00:00.000000Z",
  );
  f.replies.push({ status: 401, error: "synthetic provider failure" });
  const failed = await f.store("catchUpIfDue", [], "2026-08-30T18:00:01Z");
  assert.equal(
    failed.body.error,
    "Withings catch-up failed; provider/error details withheld.",
  );
  assert.equal(
    (await f.store("catchUpIfDue", [], "2026-08-30T18:01:00Z")).body,
    null,
  );
  assert.equal(f.requests.length, 2);
  assert.equal((await f.auth()).last_sync_at, "2026-08-29T11:00:00.000000Z");
});

test("refresh persists complete token set using injected clock and does not retry CAS conflicts", async (t) => {
  const f = await fixture(t, { expired: true });
  f.replies.push(rotated, measures([]));
  assert.equal((await f.store("catchUp")).status, 200);
  const auth = await f.auth();
  assert.equal(auth.refresh_token, "fake-new-refresh");
  assert.equal(auth.access_token_expires_at, "2026-08-30T13:00:00.000000Z");
  assert.equal(f.requests[0].form.get("refresh_token"), "fake-refresh");
  assert.equal(f.requests[1].authorization, "Bearer fake-new-access");
  await f.db
    .prepare(
      "UPDATE withings_auth SET access_token_expires_at = '2026-08-29T00:00:00.000000Z'",
    )
    .run();
  f.replies.push(async () => {
    await f.db
      .prepare(
        "UPDATE withings_auth SET refresh_token = 'fake-concurrent-refresh'",
      )
      .run();
    return rotated;
  });
  const conflicted = await f.store("catchUp");
  assert.equal(conflicted.status, 500);
  assert.match(conflicted.body.error, /credentials changed during refresh/);
  assert.equal((await f.auth()).refresh_token, "fake-concurrent-refresh");
  assert.equal(
    f.requests.length,
    3,
    "No provider side effect retried after optimistic conflict",
  );
});

test("malformed provider batches and partial refreshes leave facts and checkpoint unchanged", async (t) => {
  const f = await fixture(t);
  for (
    const body of [
      { updatetime: providerTime },
      { updatetime: "bad", measuregrps: [] },
      { updatetime: providerTime, measuregrps: [group(), { grpid: 2 }] },
    ]
  ) {
    f.replies.push({ status: 0, body });
    assert.equal((await f.store("catchUp")).status, 500);
    assert.equal((await f.weights()).length, 0);
    assert.equal((await f.auth()).last_sync_at, null);
  }
  await f.db
    .prepare(
      "UPDATE withings_auth SET access_token_expires_at = '2026-08-29T00:00:00.000000Z'",
    )
    .run();
  f.replies.push({
    status: 0,
    body: { access_token: "fake-partial", expires_in: 3600 },
  });
  assert.equal((await f.store("catchUp")).status, 500);
  assert.equal((await f.auth()).access_token, "fake-access");
  assert.equal((await f.auth()).refresh_token, "fake-refresh");
});

test("account changed during provider I/O cannot import old account or move checkpoint", async (t) => {
  const f = await fixture(t);
  f.replies.push(async () => {
    await f.db
      .prepare("UPDATE withings_auth SET withings_user_id = 'new-owner'")
      .run();
    return measures();
  });
  const result = await f.store("catchUp");
  assert.equal(result.status, 500);
  assert.match(result.body.error, /account changed during synchronization/);
  assert.equal((await f.weights()).length, 0);
  assert.equal((await f.auth()).last_sync_at, null);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM api_write_assertions").first())
      .n,
    0,
  );
});

test("webhook ignores other accounts, uses waitUntil, and missing windows trigger catch-up", async (t) => {
  const f = await fixture(t);
  const notify = (body) =>
    f.call("/api/withings/notify", { method: "POST", body });
  assert.equal((await notify("appli=1&userid=other")).status, 200);
  assert.equal((await notify("appli=2&userid=owner")).status, 200);
  assert.equal(f.requests.length, 0);
  let unblock;
  const blocked = new Promise((resolve) => {
    unblock = resolve;
  });
  f.replies.push(async () => {
    await blocked;
    return measures();
  });
  const response = await notify(
    "appli=1&userid=owner&startdate=1000&enddate=2000",
  );
  assert.equal(
    response.status,
    200,
    "Acknowledgement does not wait for provider work",
  );
  unblock();
  await eventually(async () => (await f.weights()).length === 1);
  assert.equal((await f.auth()).last_sync_at, null);
  f.replies.push(measures());
  assert.equal((await notify("appli=1&userid=owner")).status, 200);
  await eventually(async () => (await f.auth()).last_sync_at !== null);
  assert.equal(f.requests[1].form.get("lastupdate"), "0");
  assert.equal(f.requests[1].form.has("startdate"), false);
});

test("scheduled entry owns catch-up through waitUntil; missing credentials row is harmless", async (t) => {
  const f = await fixture(t);
  f.replies.push(measures([]));
  assert.equal((await f.call("/schedule")).status, 200);
  await eventually(async () => (await f.auth()).last_sync_at !== null);
  assert.equal((await f.store("catchUpIfDue")).body, null);
  await f.db.prepare("DELETE FROM withings_auth").run();
  assert.equal((await f.store("catchUpIfDue")).body, null);
  assert.equal((await f.store("configuredUserId")).body, null);
  assert.equal(f.requests.length, 1);
});
