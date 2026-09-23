import { assertEquals, assertRejects, assertThrows } from "@std/assert";
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
Deno.test("disposable receipt requires a random capability and local endpoints", () => {
  for (
    const bad of [
      null,
      {},
      receipt.apiUrl,
      { ...receipt, kind: "development" },
      { ...receipt, run: "" },
      { ...receipt, secret: "" },
      { ...receipt, managementUrl: "https://example.com/manage" },
      { ...receipt, apiUrl: "http://localhost:8000/api" },
      { ...receipt, apiUrl: "http://user:password@127.0.0.1:8000/api" },
    ]
  ) {
    assertThrows(() => parseDisposable(bad), Error, "Unsafe test database");
  }
  assertEquals(parseDisposable(receipt), receipt);
});
Deno.test("API readiness rejects partial, nonlocal and malformed addresses", () => {
  const url = receipt.apiUrl;
  for (let n = 0; n < url.length; n++) {
    assertEquals(readyApiUrl(url.slice(0, n)), undefined);
  }
  assertEquals(readyApiUrl(url), url);
  for (
    const bad of [
      "http://127.0.0.1:0/api",
      "http://127.0.0.1:65536/api",
      `${url}/extra`,
      `${url}\n`,
    ]
  ) {
    assertEquals(readyApiUrl(bad), undefined);
  }
});
Deno.test("missing receipt refuses before network or setup", async () => {
  const old = Deno.env.get("TEST_DISPOSABLE_FILE");
  Deno.env.delete("TEST_DISPOSABLE_FILE");
  try {
    await assertRejects(disposable, Error, "Unsafe test database");
  } finally {
    if (old !== undefined) Deno.env.set("TEST_DISPOSABLE_FILE", old);
  }
});
Deno.test("identity requires the owned D1 run", () => {
  for (
    const bad of [null, {}, { ...receipt, run: "c".repeat(64) }, {
      ...receipt,
      kind: "other",
    }]
  ) {
    assertThrows(
      () => assertIdentity(receipt, bad),
      Error,
      "identity does not match",
    );
  }
  assertIdentity(receipt, receipt);
});
Deno.test("an unrecognized API receives only a read-only identity probe", async () => {
  const requests: string[] = [];
  let reply: unknown = {};
  let status = 200;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req) => {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      assertEquals(
        req.headers.get("authorization"),
        `Bearer ${receipt.secret}`,
      );
      return Response.json(reply, { status });
    },
  );
  const d = { ...receipt, apiUrl: `http://127.0.0.1:${server.addr.port}/api` };
  try {
    for (const bad of [{}, { ...receipt, run: "c".repeat(64) }]) {
      reply = bad;
      await assertRejects(() => verifyApi(d), Error, "identity does not match");
    }
    status = 404;
    await assertRejects(
      () => verifyApi(d),
      Error,
      "API has no disposable identity",
    );
    status = 200;
    reply = receipt;
    await verifyApi(d);
    assertEquals(requests, Array(4).fill("GET /api/__test_identity"));
  } finally {
    await server.shutdown();
  }
});
Deno.test("the runner fails closed instead of claiming client coverage is Worker coverage", async () => {
  const source = await Deno.readTextFile("scripts/test-worker.mjs");
  assertEquals(
    source.includes("Deno client coverage is not Worker coverage"),
    true,
  );
  assertEquals(source.includes("d1Persist: false"), true);
  assertEquals(source.includes("outboundService()"), true);
});
