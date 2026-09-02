import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  fetchJwks,
  forgetJwks,
  type Jwks,
  JwtError,
  verifyJwt,
} from "../supabase/functions/api/access/jwt.ts";

// In-process, no stack: the verifier is import-free, so it runs here against
// tokens signed with a key this file generates. What Supabase does in
// production — sign with an EC P-256 key and publish the public half as a
// JWKS — is reproduced end to end with WebCrypto, so a token the test signs
// is indistinguishable in shape from one the sign-in server would.

const ISSUER = "https://example.supabase.co/auth/v1";
const NOW = 1_800_000_000; // seconds; a fixed clock so expiry is exact

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return encode(new TextEncoder().encode(JSON.stringify(value)));
}

interface Signer {
  jwks: Jwks;
  sign(
    claims: Record<string, unknown>,
    header?: Record<string, unknown>,
  ): Promise<string>;
}

async function signer(kid = "k1"): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  // Supabase publishes alg, use and key_ops beside the key itself; the
  // verifier has to cope with those, so the fixture carries them too.
  const jwks: Jwks = {
    keys: [{ ...exported, kid, alg: "ES256", use: "sig", key_ops: ["verify"] }],
  };
  return {
    jwks,
    async sign(claims, header = { alg: "ES256", typ: "JWT", kid }) {
      const signed = `${encodeJson(header)}.${encodeJson(claims)}`;
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(signed),
      );
      return `${signed}.${encode(new Uint8Array(signature))}`;
    },
  };
}

const GOOD = {
  iss: ISSUER,
  sub: "user-1",
  email: "marco@example.com",
  client_id: "client-1",
  exp: NOW + 3600,
  iat: NOW,
};

async function refused(
  token: string,
  jwks: Jwks,
  saying: string,
): Promise<JwtError> {
  const error = await assertRejects(
    () => verifyJwt(token, { issuer: ISSUER, jwks, now: NOW }),
    JwtError,
  );
  assert(
    error.message.includes(saying),
    `expected "${saying}" in "${error.message}"`,
  );
  return error;
}

Deno.test("a token our sign-in server signed is read", async (t) => {
  const s = await signer();

  await t.step("the claims come back", async () => {
    const identity = await verifyJwt(await s.sign(GOOD), {
      issuer: ISSUER,
      jwks: s.jwks,
      now: NOW,
    });
    assertEquals(identity, {
      sub: "user-1",
      email: "marco@example.com",
      client_id: "client-1",
      exp: NOW + 3600,
    });
  });

  await t.step("no client_id is null, not missing", async () => {
    const { client_id, ...rest } = GOOD;
    void client_id;
    const identity = await verifyJwt(await s.sign(rest), {
      issuer: ISSUER,
      jwks: s.jwks,
      now: NOW,
    });
    assertEquals(identity.client_id, null);
  });

  await t.step("a token expired within the leeway still passes", async () => {
    const token = await s.sign({ ...GOOD, exp: NOW - 30 });
    await verifyJwt(token, { issuer: ISSUER, jwks: s.jwks, now: NOW });
  });

  await t.step("no kid is fine when there is one key", async () => {
    const token = await s.sign(GOOD, { alg: "ES256", typ: "JWT" });
    await verifyJwt(token, { issuer: ISSUER, jwks: s.jwks, now: NOW });
  });
});

Deno.test("every other token is refused with a sentence", async (t) => {
  const s = await signer();
  const other = await signer();

  await t.step("signed by someone else's key", async () => {
    await refused(await other.sign(GOOD), s.jwks, "signature");
  });

  await t.step("issued by another server", async () => {
    await refused(
      await s.sign({ ...GOOD, iss: "https://other.example/auth/v1" }),
      s.jwks,
      "issued by",
    );
  });

  await t.step("expired past the leeway", async () => {
    await refused(await s.sign({ ...GOOD, exp: NOW - 61 }), s.jwks, "expired");
  });

  await t.step("not valid yet", async () => {
    await refused(
      await s.sign({ ...GOOD, nbf: NOW + 120 }),
      s.jwks,
      "not valid yet",
    );
  });

  await t.step('"none" is refused on the header alone', async () => {
    // A signature made with the real key, under a header that says none: the
    // refusal must come from the algorithm, before any verification.
    const token = await s.sign(GOOD, { alg: "none", typ: "JWT" });
    await refused(token, s.jwks, "only ES256");
  });

  await t.step("HS256 is refused on the header alone", async () => {
    const token = await s.sign(GOOD, { alg: "HS256", typ: "JWT" });
    await refused(token, s.jwks, "only ES256");
  });

  await t.step("a kid the key set does not hold, and says so", async () => {
    const token = await s.sign(GOOD, { alg: "ES256", kid: "rotated" });
    const error = await refused(token, s.jwks, "does not publish");
    assertEquals(error.unknownKid, true);
  });

  await t.step("no kid, with two keys to choose from", async () => {
    const token = await s.sign(GOOD, { alg: "ES256" });
    const two: Jwks = { keys: [...s.jwks.keys, ...other.jwks.keys] };
    await refused(token, two, "more than one");
  });

  await t.step("a tampered payload", async () => {
    const [h, p, sig] = (await s.sign(GOOD)).split(".");
    const forged = encodeJson({ ...GOOD, email: "someone@else.example" });
    await refused(`${h}.${forged}.${sig}`, s.jwks, "signature");
    assert(p !== forged);
  });

  await t.step("no email", async () => {
    const { email, ...rest } = GOOD;
    void email;
    await refused(await s.sign(rest), s.jwks, "email");
  });

  await t.step("garbage", async () => {
    await refused("abc", s.jwks, "three");
    await refused("a.b", s.jwks, "three");
    await refused("a.b.c", s.jwks, "not JSON");
  });

  await t.step("every refusal is a JwtError, never a bare throw", async () => {
    const error = await assertRejects(
      () => verifyJwt("!!!.!!!.!!!", { issuer: ISSUER, jwks: s.jwks }),
      JwtError,
    );
    assert(error.message.length > 0);
  });
});

Deno.test("the key set is fetched rarely", async (t) => {
  const s = await signer();
  let hits = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => {
      hits++;
      const path = new URL(request.url).pathname;
      if (path === "/jwks.json") return Response.json(s.jwks);
      if (path === "/not-keys.json") return Response.json({ hello: "world" });
      return new Response("not here", { status: 404 });
    },
  );
  const url = `http://127.0.0.1:${server.addr.port}/jwks.json`;
  const t0 = 1_000_000;
  forgetJwks();

  try {
    await t.step("the second read is served from memory", async () => {
      await fetchJwks(url, { now: t0 });
      await fetchJwks(url, { now: t0 + 1000 });
      assertEquals(hits, 1);
    });

    await t.step("a known kid does not refetch", async () => {
      await fetchJwks(url, { now: t0 + 2000, unknownKid: "k1" });
      assertEquals(hits, 1);
    });

    await t.step("an unknown kid refetches once", async () => {
      // Two minutes on, so the refetch is not held back by the last one.
      await fetchJwks(url, { now: t0 + 120_000, unknownKid: "rotated" });
      assertEquals(hits, 2);
    });

    await t.step("a burst of unknown kids does not refetch again", async () => {
      await fetchJwks(url, { now: t0 + 121_000, unknownKid: "rotated-2" });
      await fetchJwks(url, { now: t0 + 122_000, unknownKid: "rotated-3" });
      assertEquals(hits, 2);
    });

    await t.step("an hour on, the keys are read again", async () => {
      await fetchJwks(url, { now: t0 + 120_000 + 60 * 60 * 1000 });
      assertEquals(hits, 3);
    });

    await t.step(
      "a server that does not answer with keys is an error",
      async () => {
        forgetJwks();
        const base = url.replace(/\/jwks\.json$/, "");
        await assertRejects(
          () => fetchJwks(`${base}/nope.json`),
          Error,
          "answered 404",
        );
        await assertRejects(
          () => fetchJwks(`${base}/not-keys.json`),
          Error,
          "did not answer with a key set",
        );
      },
    );
  } finally {
    await server.shutdown();
  }
});
