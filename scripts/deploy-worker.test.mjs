import assert from "node:assert/strict";
import test from "node:test";
import { verifyRelease } from "./deploy-worker.mjs";

const expected = { revision: "a".repeat(40), digest: "b".repeat(64) };
const endpoint = "https://trainer.example/api/health";
const reply = (body, headers = { "Cache-Control": "no-store" }) =>
  Response.json(body, { headers });

for (
  const [name, response] of [
    [
      "old healthy code",
      () => reply({ status: "ok", revision: expected.revision, build: "old" }),
    ],
    ["wrong commit", () =>
      reply({
        status: "ok",
        revision: "c".repeat(40),
        build: expected.digest,
      })],
    [
      "missing build",
      () => reply({ status: "ok", revision: expected.revision }),
    ],
    ["cached readiness", () =>
      reply({
        status: "ok",
        revision: expected.revision,
        build: expected.digest,
      }, {})],
    [
      "database unavailable",
      () => new Response("unavailable", { status: 503 }),
    ],
    ["malformed response", () => new Response("not JSON")],
    ["network failure", () => {
      throw new Error("Synthetic failure");
    }],
  ]
) {
  test(`release verification refuses ${name}`, async () => {
    await assert.rejects(
      verifyRelease(endpoint, expected, {
        attempts: 1,
        fetcher: response,
      }),
      /migrations may already have changed production/,
    );
  });
}

test("release requires the exact build and makes uncached bounded probes", async () => {
  let probes = 0;
  await verifyRelease(endpoint, expected, {
    attempts: 2,
    sleep: () => Promise.resolve(),
    fetcher(url, options) {
      assert.ok(url.searchParams.get("release_probe"));
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["Cache-Control"], "no-cache");
      assert.ok(options.signal instanceof AbortSignal);
      return ++probes === 1
        ? new Response("unavailable", { status: 503 })
        : reply({
          status: "ok",
          revision: expected.revision,
          build: expected.digest,
        });
    },
  });
  assert.equal(probes, 2);
});

test("an uncommitted artifact never claims to be a commit", async () => {
  const local = { ...expected, revision: null };
  await verifyRelease(endpoint, local, {
    attempts: 1,
    fetcher: () => reply({ status: "ok", revision: null, build: local.digest }),
  });
});

test("release refuses cleartext verification", async () => {
  await assert.rejects(
    verifyRelease("http://trainer.example/api/health", expected),
    /requires HTTPS/,
  );
});
