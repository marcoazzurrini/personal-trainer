import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  canonicalResource,
  discoverJwksUrl,
  fetchJwks,
  forgetJwks,
  type Jwks,
  JwtError,
  metadataUrl,
  verifyJwt,
} from "../api/access/jwt.ts";

// In-process, no stack: the verifier is import-free, so it runs here against
// tokens signed with keys this file generates. What an authorization server
// does in production — sign with an RSA or an EC key and publish the public
// half as a key set — is reproduced end to end with WebCrypto, so a token the
// test signs is indistinguishable in shape from one the server would issue.

const ISSUER = "https://auth.example.test";
const AUDIENCE = "https://x.example/api/mcp";
const NOW = 1_800_000_000; // seconds; a fixed clock so expiry is exact

type Alg = "ES256" | "RS256";
const ALGS: Alg[] = ["ES256", "RS256"];

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
  alg: Alg;
  jwks: Jwks;
  sign(
    claims: Record<string, unknown>,
    header?: Record<string, unknown>,
  ): Promise<string>;
}

async function signer(alg: Alg = "ES256", kid = "k1"): Promise<Signer> {
  const pair = alg === "ES256"
    ? await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )
    : await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  // A published key set carries alg, use and key_ops beside the key itself;
  // the verifier has to cope with those, so the fixture carries them too.
  const jwks: Jwks = {
    keys: [{ ...exported, kid, alg, use: "sig", key_ops: ["verify"] }],
  };
  return {
    alg,
    jwks,
    async sign(claims, header = { alg, typ: "JWT", kid }) {
      const signed = `${encodeJson(header)}.${encodeJson(claims)}`;
      const signature = await crypto.subtle.sign(
        alg === "ES256"
          ? { name: "ECDSA", hash: "SHA-256" }
          : { name: "RSASSA-PKCS1-v1_5" },
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
  aud: AUDIENCE,
  exp: NOW + 3600,
  iat: NOW,
};

function check(token: string, jwks: Jwks) {
  return verifyJwt(token, {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks,
    now: NOW,
  });
}

async function refused(
  token: string,
  jwks: Jwks,
  saying: string,
): Promise<JwtError> {
  const error = await assertRejects(() => check(token, jwks), JwtError);
  assert(
    error.message.includes(saying),
    `expected "${saying}" in "${error.message}"`,
  );
  return error;
}

Deno.test("a token the authorization server signed is read", async (t) => {
  for (const alg of ALGS) {
    const s = await signer(alg);

    await t.step(`${alg}: the claims come back`, async () => {
      assertEquals(await check(await s.sign(GOOD), s.jwks), {
        sub: "user-1",
        email: "marco@example.com",
        client_id: "client-1",
        exp: NOW + 3600,
      });
    });

    await t.step(`${alg}: no client_id and no email are null`, async () => {
      const { client_id, email, ...rest } = GOOD;
      void client_id;
      void email;
      const identity = await check(await s.sign(rest), s.jwks);
      assertEquals(identity.client_id, null);
      assertEquals(identity.email, null);
    });

    await t.step(`${alg}: expired within the leeway still passes`, async () => {
      await check(await s.sign({ ...GOOD, exp: NOW - 30 }), s.jwks);
    });

    await t.step(`${alg}: no kid is fine when there is one key`, async () => {
      await check(await s.sign(GOOD, { alg, typ: "JWT" }), s.jwks);
    });

    await t.step(`${alg}: the audience may be a list`, async () => {
      await check(
        await s.sign({ ...GOOD, aud: ["https://other.example", AUDIENCE] }),
        s.jwks,
      );
    });

    await t.step(`${alg}: the audience is compared as a place`, async () => {
      // Host case and a trailing slash are spelling, not a different resource.
      await check(
        await s.sign({
          ...GOOD,
          aud: "https://X.EXAMPLE/api/mcp/",
        }),
        s.jwks,
      );
    });
  }
});

Deno.test("every other token is refused with a sentence", async (t) => {
  const ec = await signer("ES256");
  const rsa = await signer("RS256");
  const other = await signer("ES256");

  await t.step("signed by someone else's key", async () => {
    await refused(await other.sign(GOOD), ec.jwks, "signature");
    await refused(
      await (await signer("RS256")).sign(GOOD),
      rsa.jwks,
      "signature",
    );
  });

  await t.step("issued by another server", async () => {
    await refused(
      await ec.sign({ ...GOOD, iss: "https://other.example/auth/v1" }),
      ec.jwks,
      "issued by",
    );
  });

  await t.step("expired past the leeway", async () => {
    await refused(
      await ec.sign({ ...GOOD, exp: NOW - 61 }),
      ec.jwks,
      "expired",
    );
  });

  await t.step("not valid yet", async () => {
    await refused(
      await ec.sign({ ...GOOD, nbf: NOW + 120 }),
      ec.jwks,
      "not valid yet",
    );
  });

  await t.step('"none" and HS256 are refused on the header alone', async () => {
    // A signature made with a real key, under a header that claims another
    // algorithm: the refusal must come from the header, before any key.
    await refused(
      await ec.sign(GOOD, { alg: "none", typ: "JWT" }),
      ec.jwks,
      "only RS256 or ES256",
    );
    await refused(
      await ec.sign(GOOD, { alg: "HS256", typ: "JWT" }),
      ec.jwks,
      "only RS256 or ES256",
    );
  });

  await t.step("a header naming the wrong kind of key", async () => {
    // Algorithm confusion: an RS256 header pointed at an EC key, and the
    // reverse. Neither key ever meets the signature.
    await refused(
      await ec.sign(GOOD, { alg: "RS256", kid: "k1" }),
      ec.jwks,
      "not an RSA key",
    );
    await refused(
      await rsa.sign(GOOD, { alg: "ES256", kid: "k1" }),
      rsa.jwks,
      "not a P-256 key",
    );
  });

  await t.step("a kid the key set does not hold, and says so", async () => {
    const token = await ec.sign(GOOD, { alg: "ES256", kid: "rotated" });
    const error = await refused(token, ec.jwks, "does not publish");
    assertEquals(error.unknownKid, true);
  });

  await t.step("no kid, with two keys to choose from", async () => {
    const token = await ec.sign(GOOD, { alg: "ES256" });
    const two: Jwks = { keys: [...ec.jwks.keys, ...other.jwks.keys] };
    await refused(token, two, "more than one");
  });

  await t.step("a tampered payload", async () => {
    const [h, p, sig] = (await ec.sign(GOOD)).split(".");
    const forged = encodeJson({ ...GOOD, sub: "someone-else" });
    await refused(`${h}.${forged}.${sig}`, ec.jwks, "signature");
    assert(p !== forged);
  });

  await t.step("for another resource, or for none", async () => {
    const { aud, ...noAud } = GOOD;
    void aud;
    await refused(await ec.sign(noAud), ec.jwks, "no resource");
    await refused(
      await ec.sign({ ...GOOD, aud: "https://x.example/api" }),
      ec.jwks,
      "not for this endpoint",
    );
    await refused(
      await ec.sign({
        ...GOOD,
        aud: ["https://a.example", "https://b.example"],
      }),
      ec.jwks,
      "not for this endpoint",
    );
  });

  await t.step("no subject", async () => {
    const { sub, ...rest } = GOOD;
    void sub;
    await refused(await ec.sign(rest), ec.jwks, "subject");
  });

  await t.step("garbage", async () => {
    await refused("abc", ec.jwks, "three");
    await refused("a.b", ec.jwks, "three");
    await refused("a.b.c", ec.jwks, "not JSON");
  });

  await t.step("every refusal is a JwtError, never a bare throw", async () => {
    const error = await assertRejects(
      () =>
        verifyJwt("!!!.!!!.!!!", {
          issuer: ISSUER,
          audience: AUDIENCE,
          jwks: ec.jwks,
        }),
      JwtError,
    );
    assert(error.message.length > 0);
  });
});

Deno.test("one spelling of a resource", () => {
  const same = "https://x.example/api/mcp";
  assertEquals(canonicalResource(same + "/"), same);
  assertEquals(
    canonicalResource("HTTPS://X.EXAMPLE/api/mcp"),
    same,
  );
  assertEquals(canonicalResource(same + "#frag"), same);
  assertEquals(canonicalResource("https://x.example/"), "https://x.example");
  assertEquals(canonicalResource("not a url"), "not a url");
});

Deno.test("where an issuer publishes its metadata", () => {
  assertEquals(
    metadataUrl("https://x.authkit.app"),
    "https://x.authkit.app/.well-known/oauth-authorization-server",
  );
  assertEquals(
    metadataUrl("https://x.example/auth/v1/"),
    "https://x.example/.well-known/oauth-authorization-server/auth/v1",
  );
});

Deno.test("the metadata and the key set are read rarely", async (t) => {
  const s = await signer("RS256");
  let hits = 0;
  let base = "";
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => {
      hits++;
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json({ issuer: base, jwks_uri: `${base}/jwks.json` });
      }
      if (path === "/.well-known/oauth-authorization-server/auth/v1") {
        return Response.json({
          issuer: `${base}/auth/v1`,
          jwks_uri: `${base}/auth/v1/jwks.json`,
        });
      }
      if (path === "/.well-known/oauth-authorization-server/no-keys") {
        return Response.json({ issuer: `${base}/no-keys` });
      }
      if (path === "/.well-known/oauth-authorization-server/liar") {
        return Response.json({
          issuer: "https://elsewhere.example",
          jwks_uri: `${base}/jwks.json`,
        });
      }
      if (path === "/jwks.json") return Response.json(s.jwks);
      if (path === "/not-keys.json") return Response.json({ hello: "world" });
      return new Response("not here", { status: 404 });
    },
  );
  base = `http://127.0.0.1:${server.addr.port}`;
  const url = `${base}/jwks.json`;
  const t0 = 1_000_000;
  forgetJwks();

  try {
    await t.step("the key set's address comes from the metadata", async () => {
      assertEquals(await discoverJwksUrl(base, { now: t0 }), url);
      assertEquals(hits, 1);
      assertEquals(await discoverJwksUrl(base, { now: t0 + 1000 }), url);
      assertEquals(hits, 1);
    });

    await t.step("an issuer with a path is described under it", async () => {
      assertEquals(
        await discoverJwksUrl(`${base}/auth/v1`, { now: t0 }),
        `${base}/auth/v1/jwks.json`,
      );
    });

    await t.step(
      "metadata that is not the issuer's, or names no keys",
      async () => {
        await assertRejects(
          () => discoverJwksUrl(`${base}/no-keys`),
          Error,
          "did not name a jwks_uri",
        );
        await assertRejects(
          () => discoverJwksUrl(`${base}/liar`),
          Error,
          "names issuer",
        );
        await assertRejects(
          () => discoverJwksUrl(`${base}/missing`),
          Error,
          "answered 404",
        );
      },
    );

    const before = hits;
    await t.step(
      "the second read of the keys is served from memory",
      async () => {
        await fetchJwks(url, { now: t0 });
        await fetchJwks(url, { now: t0 + 1000 });
        assertEquals(hits, before + 1);
      },
    );

    await t.step("a known kid does not refetch", async () => {
      await fetchJwks(url, { now: t0 + 2000, unknownKid: "k1" });
      assertEquals(hits, before + 1);
    });

    await t.step("an unknown kid refetches once", async () => {
      // Two minutes on, so the refetch is not held back by the last one.
      await fetchJwks(url, { now: t0 + 120_000, unknownKid: "rotated" });
      assertEquals(hits, before + 2);
    });

    await t.step("a burst of unknown kids does not refetch again", async () => {
      await fetchJwks(url, { now: t0 + 121_000, unknownKid: "rotated-2" });
      await fetchJwks(url, { now: t0 + 122_000, unknownKid: "rotated-3" });
      assertEquals(hits, before + 2);
    });

    await t.step("an hour on, the keys are read again", async () => {
      await fetchJwks(url, { now: t0 + 120_000 + 60 * 60 * 1000 });
      assertEquals(hits, before + 3);
    });

    await t.step(
      "a server that does not answer with keys is an error",
      async () => {
        forgetJwks();
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
