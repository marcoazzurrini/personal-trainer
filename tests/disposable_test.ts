import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  assertIdentity,
  disposable,
  parseDisposable,
  readyApiUrl,
  verifyApi,
} from "./disposable.ts";

const receipt = {
  kind: "personal-trainer-disposable-v1",
  containerId: "a".repeat(64),
  systemId: "1234567890123456789",
  database: `pt_test_${"a".repeat(32)}`,
  databaseUrl: `postgresql://postgres:synthetic@127.0.0.1:5432/pt_test_${
    "a".repeat(32)
  }`,
  apiUrl: "http://127.0.0.1:8000/api",
};

Deno.test("disposable Postgres readiness cannot use the initialization socket", async () => {
  const source = await Deno.readTextFile("scripts/test.ts");
  const command = source.match(/"(pg_isready [^"]+)"/)?.[1] ?? "";
  const assertTcp = (value: string) =>
    assertMatch(value, /\bpg_isready -h 127\.0\.0\.1 -U postgres\b/);
  assertTcp(command);
  assertThrows(() => assertTcp(command.replace("-h 127.0.0.1 ", "")));
});

Deno.test("API readiness waits through empty and incomplete addresses", () => {
  const url = "http://127.0.0.1:54321/api";
  // Every possible partial write must keep polling; only the full value is ready.
  for (let length = 0; length < url.length; length++) {
    assertEquals(readyApiUrl(url.slice(0, length)), undefined);
  }
  assertEquals(readyApiUrl(url), url);
  for (
    const invalid of [
      "http://127.0.0.1:0/api",
      "http://127.0.0.1:65536/api",
      "http://localhost:8000/api",
      "https://127.0.0.1:8000/api",
      "http://192.0.2.1:8000/api",
      `${url}/extra`,
      `${url}\n`,
    ]
  ) assertEquals(readyApiUrl(invalid), undefined);
});

Deno.test("disposable receipt refuses a URL or opt-in flag, even on loopback", () => {
  for (
    const bad of [
      undefined,
      null,
      {},
      receipt.databaseUrl,
      { databaseUrl: receipt.databaseUrl, yesDelete: true },
      { ...receipt, kind: "development" },
      { ...receipt, systemId: undefined },
      { ...receipt, containerId: "not-owned" },
      {
        ...receipt,
        databaseUrl: "postgresql://postgres:synthetic@127.0.0.1:5432/postgres",
      },
    ]
  ) {
    assertThrows(() => parseDisposable(bad), Error, "Unsafe test database");
  }
  assertEquals(parseDisposable(receipt), receipt);
});

Deno.test("missing receipt refuses before any network or setup work", async () => {
  const previous = Deno.env.get("TEST_DISPOSABLE_FILE");
  Deno.env.delete("TEST_DISPOSABLE_FILE");
  try {
    await assertRejects(() => disposable(), Error, "Unsafe test database");
  } finally {
    if (previous !== undefined) Deno.env.set("TEST_DISPOSABLE_FILE", previous);
  }
});

Deno.test("disposable identity requires both the fresh cluster and the database", () => {
  for (
    const actual of [
      null,
      {},
      { ...receipt, systemId: "9876543210987654321" },
      { ...receipt, database: "postgres" },
    ]
  ) {
    assertThrows(
      () => assertIdentity(receipt, actual),
      Error,
      "identity does not match",
    );
  }
  assertIdentity(receipt, receipt);
});

Deno.test("a loopback API with missing or mismatched identity is never sent a write", async () => {
  const requests: string[] = [];
  let reply: unknown = { status: "ok" };
  let status = 200;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req) => {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json(reply, { status });
    },
  );
  const d = parseDisposable({
    ...receipt,
    apiUrl: `http://127.0.0.1:${server.addr.port}/api`,
  });
  try {
    for (
      const bad of [
        { status: "ok" },
        { ...receipt, systemId: "9876543210987654321" },
        { ...receipt, database: "postgres" },
      ]
    ) {
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
    assertEquals(requests, Array(5).fill("GET /api/__test_identity"));
  } finally {
    await server.shutdown();
  }
});
