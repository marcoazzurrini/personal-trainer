import { assertEquals, assertRejects } from "@std/assert";
import { discoverJwksUrl, fetchJwks, forgetJwks } from "../access/jwt.ts";

Deno.test("JWT publication reads coalesce, cool down failures, recover and reset", async (t) => {
  let hits = 0;
  let fail = false;
  let release = Promise.withResolvers<void>();
  let entered = Promise.withResolvers<void>();
  let base = "";
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      hits++;
      const gate = release.promise;
      entered.resolve();
      await gate;
      if (fail) return new Response("offline", { status: 503 });
      return Response.json(
        new URL(req.url).pathname === "/keys"
          ? { keys: [{ kid: "known" }] }
          : { issuer: base, jwks_uri: `${base}/keys` },
      );
    },
  );
  base = `http://127.0.0.1:${server.addr.port}`;
  try {
    for (const kind of ["keys", "metadata"] as const) {
      await t.step(kind, async () => {
        forgetJwks();
        hits = 0;
        fail = false;
        const read = (now: number) =>
          kind === "keys"
            ? fetchJwks(`${base}/keys`, { now, unknownKid: "rotated" })
            : discoverJwksUrl(base, { now });
        async function burst(now: number) {
          release = Promise.withResolvers<void>();
          entered = Promise.withResolvers<void>();
          const pending = Array.from({ length: 10 }, () => read(now));
          const settled = Promise.allSettled(pending);
          await entered.promise;
          release.resolve();
          return await settled;
        }
        assertEquals(
          (await burst(1_000_000)).map((r) => r.status),
          Array(10).fill("fulfilled"),
        );
        assertEquals(hits, 1);
        // Expired metadata or an unknown kid outside the successful throttle.
        const next = kind === "keys" ? 1_120_000 : 5_000_000;
        fail = true;
        assertEquals(
          (await burst(next)).map((r) => r.status),
          Array(10).fill("rejected"),
        );
        assertEquals(hits, 2);
        await assertRejects(() => read(next + 1000), Error, "answered 503");
        assertEquals(hits, 2);
        fail = false;
        await read(next + 60_000);
        assertEquals(hits, 3);
        forgetJwks();
        await read(next + 60_001);
        assertEquals(hits, 4);

        // A pre-reset completion must not become a post-reset cache hit.
        forgetJwks();
        release = Promise.withResolvers<void>();
        entered = Promise.withResolvers<void>();
        const old = read(next + 60_002);
        await entered.promise;
        forgetJwks();
        release.resolve();
        await old;
        await read(next + 60_003);
        assertEquals(hits, 6);
      });
    }
  } finally {
    release.resolve();
    forgetJwks();
    await server.shutdown();
  }
});
