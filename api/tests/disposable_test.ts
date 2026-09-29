import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { assertEquals, assertRejects, assertThrows } from "./assertions.ts";
import {
  assertIdentity,
  disposable,
  parseDisposable,
  readyApiUrl,
  verifyApi,
} from "./disposable.ts";

const receipt = {
  kind: "personal-trainer-worker-d1-v1" as const,
  run: "a".repeat(64),
  secret: "b".repeat(64),
  apiUrl: "http://127.0.0.1:8000/api",
  managementUrl: "http://127.0.0.1:8001/manage",
};
test("disposable receipt requires a random capability and local endpoints", () => {
  for (const bad of [
    null,
    {},
    receipt.apiUrl,
    { ...receipt, kind: "development" },
    { ...receipt, run: "" },
    { ...receipt, secret: "" },
    { ...receipt, managementUrl: "https://example.com/manage" },
    { ...receipt, apiUrl: "http://localhost:8000/api" },
    { ...receipt, apiUrl: "http://user:password@127.0.0.1:8000/api" },
  ]) {
    assertThrows(() => parseDisposable(bad), Error, "Unsafe test database");
  }
  assertEquals(parseDisposable(receipt), receipt);
});
test("API readiness rejects partial, nonlocal and malformed addresses", () => {
  const url = receipt.apiUrl;
  for (let n = 0; n < url.length; n++) {
    assertEquals(readyApiUrl(url.slice(0, n)));
  }
  assertEquals(readyApiUrl(url), url);
  for (const bad of [
    "http://127.0.0.1:0/api",
    "http://127.0.0.1:65536/api",
    `${url}/extra`,
    `${url}\n`,
  ]) {
    assertEquals(readyApiUrl(bad));
  }
});
test("missing receipt refuses before network or setup", async () => {
  const old = process.env["TEST_DISPOSABLE_FILE"];
  delete process.env["TEST_DISPOSABLE_FILE"];
  try {
    await assertRejects(disposable, Error, "Unsafe test database");
  } finally {
    if (old !== undefined) {
      process.env["TEST_DISPOSABLE_FILE"] = old;
    }
  }
});
test("identity requires the owned D1 run", () => {
  for (const bad of [
    null,
    {},
    { ...receipt, run: "c".repeat(64) },
    {
      ...receipt,
      kind: "other",
    },
  ]) {
    assertThrows(
      () => assertIdentity(receipt, bad),
      Error,
      "identity does not match"
    );
  }
  assertIdentity(receipt, receipt);
});
test("an unrecognized API receives only a read-only identity probe", async () => {
  const requests: string[] = [];
  let reply = {};
  let status = 200;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      assertEquals(
        req.headers.get("authorization"),
        `Bearer ${receipt.secret}`
      );
      return Response.json(reply, { status });
    },
  });
  const d = { ...receipt, apiUrl: `http://127.0.0.1:${server.port}/api` };
  try {
    for (const bad of [{}, { ...receipt, run: "c".repeat(64) }]) {
      reply = bad;
      await assertRejects(() => verifyApi(d), Error, "identity does not match");
    }
    status = 404;
    await assertRejects(
      () => verifyApi(d),
      Error,
      "API has no disposable identity"
    );
    status = 200;
    reply = receipt;
    await verifyApi(d);
    assertEquals(
      requests,
      Array.from({ length: 4 }, () => "GET /api/__test_identity")
    );
  } finally {
    await server.stop(true);
  }
});
test("the runner fails closed instead of claiming client coverage is Worker coverage", async () => {
  const source = await readFile("api/tests/run.ts", "utf-8");
  assertEquals(
    source.includes("Bun client coverage is not Worker coverage"),
    true
  );
  assertEquals(source.includes("d1Persist: false"), true);
  assertEquals(source.includes("outboundService()"), true);
});
