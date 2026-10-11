// Checking a sign-in token: is it ours, is it still good, and who is it for.
//
// The connector receives one of these on every call — the access token the
// authorization server issued to Claude after Marco signed in. Such a server
// publishes the public half of its signing keys, and says where in its
// metadata, so the check is local: read the metadata once, read the keys
// once, verify the signature with WebCrypto, read the claims. No round trip
// to the server per call, and no library — the whole of RS256 and ES256 is
// one importKey and one verify each.
//
// Nothing here names a provider. What a provider decides is held in two
// values the caller passes in: the issuer, and the audience this endpoint
// expects to find in the token.
//
// Free of the database and the API on purpose, like surfaces/github.ts: the
// unit tests sign tokens with keys they generate and run this file without a
// database or API server. Time is the Effect Clock's, so a test sets it.

/* oxlint-disable max-classes-per-file -- A refusal of the token and an unreachable server are the two failures every caller tells apart. */
import { Cache, Clock, Data, Effect, Exit } from "effect";

export class JwtError extends Data.TaggedError("JwtError")<{
  readonly message: string;
  // Set when the token names a key the key set does not hold. The caller may
  // refetch the keys once for that case — a rotated key is the ordinary
  // reason — and every other refusal is final.
  readonly unknownKid?: boolean;
}> {}

// The metadata or the keys could not be read. Never a JwtError: nothing here
// is a refusal of the token, only a failure to reach the server that could
// judge it, and the routes answer those differently.
export class AuthorizationServerError extends Data.TaggedError(
  "AuthorizationServerError"
)<{
  readonly message: string;
}> {}

/** Compare credentials through native HMAC verification, not JavaScript equality. */
export async function timingSafeEqual(
  left: string,
  right: string
): Promise<boolean> {
  const key = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(left));
  return await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(right)
  );
}

export interface Jwks {
  keys: (JsonWebKey & { kid?: string })[];
}

export interface Identity {
  sub: string;
  // Not every server puts an email in an access token, and this one is not
  // relied on: identity is the subject. Kept when present, for the record.
  email: string | null;
  client_id: string | null;
  exp: number;
}

// The two signature algorithms an authorization server publishes public keys
// for. HMAC algorithms are refused by construction: a shared secret has no
// public half to publish, and a token claiming one has no business here.
export type Alg = "RS256" | "ES256";

function isAlg(value: unknown): value is Alg {
  return value === "RS256" || value === "ES256";
}

// Seconds either side of the clock a token may be, to absorb the drift
// between the authorization server's clock and this one.
const LEEWAY_SECONDS = 60;

// Returns bytes over a plain ArrayBuffer: WebCrypto's verify() refuses a view
// that might sit on a SharedArrayBuffer, which is what Uint8Array.from yields
// in the type system.
export function decodeBase64Url(
  text: string
): Effect.Effect<Uint8Array<ArrayBuffer>, JwtError> {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Effect.try({
    try: () => atob(padded),
    catch: () => new JwtError({ message: "The token is not base64url." }),
  }).pipe(
    Effect.map((binary) => {
      const bytes = new Uint8Array(new ArrayBuffer(binary.length));
      for (let i = 0; i < binary.length; i++) {
        // eslint-disable-next-line unicorn/prefer-code-point -- atob returns byte-valued code units, not Unicode text; preserve the exact decoded bytes.
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    })
  );
}

// eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Decoded JWT and issuer JSON fields remain unknown until their individual boundary checks.
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Undecodable and unparsable read the same from outside: either way the
// segment is not JSON.
function decodeJson(
  segment: string,
  what: string
): Effect.Effect<JsonObject, JwtError> {
  return decodeBase64Url(segment).pipe(
    Effect.flatMap((bytes) =>
      Effect.try(() => JSON.parse(new TextDecoder().decode(bytes)))
    ),
    Effect.mapError(
      () => new JwtError({ message: `The token's ${what} is not JSON.` })
    ),
    Effect.flatMap((parsed) =>
      isJsonObject(parsed)
        ? Effect.succeed(parsed)
        : Effect.fail(
            new JwtError({ message: `The token's ${what} is not an object.` })
          )
    )
  );
}

// The key is imported for the algorithm the header claims, and refused if
// its type does not fit that algorithm. That is the guard against algorithm
// confusion: a header cannot talk an RSA key into acting as an EC key or the
// reverse, because the wrong kind of key never reaches verify(). Only the
// fields that define the key are handed to importKey — a published key set
// carries alg, use and key_ops beside them, and WebCrypto is strict about
// extras.
function importKey(
  jwk: JsonWebKey,
  alg: Alg
): Effect.Effect<CryptoKey, JwtError> {
  if (alg === "RS256") {
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) {
      return Effect.fail(
        new JwtError({
          message:
            "The token says RS256 but the key it names is not an RSA key.",
        })
      );
    }
    const { n, e } = jwk;
    return Effect.promise(() =>
      crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n, e },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      )
    );
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    return Effect.fail(
      new JwtError({
        message:
          "The token says ES256 but the key it names is not a P-256 key.",
      })
    );
  }
  const { x, y } = jwk;
  return Effect.promise(() =>
    crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x, y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    )
  );
}

function pickKey(
  jwks: Jwks,
  kid: string | null
): Effect.Effect<JsonWebKey, JwtError> {
  if (kid !== null) {
    const match = jwks.keys.find((key) => key.kid === kid);
    if (match === undefined) {
      return Effect.fail(
        new JwtError({
          message: `The token is signed with key "${kid}", which the authorization server does not publish.`,
          unknownKid: true,
        })
      );
    }
    return Effect.succeed(match);
  }
  // No kid: only unambiguous when there is one key to choose from.
  if (jwks.keys.length !== 1) {
    return Effect.fail(
      new JwtError({
        message:
          "The token names no signing key and the authorization server publishes more than one.",
      })
    );
  }
  return Effect.succeed(jwks.keys[0]);
}

// The header alone: the shape of the token and the algorithm it claims, read
// before any key is fetched or touched. A token claiming "none" or an HMAC
// algorithm is refused here, so no key material ever meets a signature it was
// not made for; and a caller can learn which key the token names before it
// goes looking for one.
interface TokenHeader {
  alg: Alg;
  kid: string | null;
  segments: [string, string, string];
}

export const readHeader = Effect.fn("jwt.readHeader")(function* (
  token: string
): Effect.fn.Return<TokenHeader, JwtError> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return yield* new JwtError({
      message: "The token is not three dot-separated segments.",
    });
  }
  const header = yield* decodeJson(parts[0], "header");
  if (!isAlg(header.alg)) {
    return yield* new JwtError({
      message: `The token is signed with "${String(
        header.alg
      )}"; only RS256 or ES256 is accepted.`,
    });
  }
  return {
    alg: header.alg,
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- A raw JWT header supplies an optional kid; only a string participates in key selection.
    kid: typeof header.kid === "string" ? header.kid : null,
    segments: [parts[0], parts[1], parts[2]],
  };
});

// One spelling of a resource URL, so the token's audience and this
// endpoint's own address compare as the same place however each was
// written: the scheme and host lowercased (the URL parser does that), a
// trailing slash dropped, a fragment dropped. Anything that is not a URL is
// returned as it came, and then only equals itself.
export function canonicalResource(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  return `${parsed.origin}${parsed.pathname.replace(
    /\/+$/u,
    ""
  )}${parsed.search}`;
}

interface VerifiedClaims extends JsonObject {
  sub: string;
  exp: number;
}

// Shared cryptographic checks do not decide which application may use a token.
// Each public verifier below applies its own, non-interchangeable claim policy.
// A key WebCrypto cannot use is a defect, not a refusal: the callers answer
// every failure but a refusal as the server being unreachable.
const verifiedClaims = Effect.fn("jwt.verifiedClaims")(function* (
  token: string,
  opts: { issuer: string; jwks: Jwks }
): Effect.fn.Return<VerifiedClaims, JwtError> {
  const { alg, kid, segments } = yield* readHeader(token);
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  const key = yield* importKey(yield* pickKey(opts.jwks, kid), alg);
  const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  const signature = yield* decodeBase64Url(signatureSegment);
  const valid = yield* Effect.promise(() =>
    crypto.subtle.verify(
      alg === "RS256"
        ? { name: "RSASSA-PKCS1-v1_5" }
        : { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      signed
    )
  );
  if (!valid) {
    return yield* new JwtError({
      message: "The token's signature does not verify.",
    });
  }

  const claims = yield* decodeJson(payloadSegment, "payload");
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  if (claims.iss !== opts.issuer) {
    return yield* new JwtError({
      message: `The token was issued by "${String(
        claims.iss
      )}", not by this project's authorization server.`,
    });
  }
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- Validate the signed payload's expiry before applying the existing clock leeway.
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS <= now) {
    return yield* new JwtError({
      message: "The token has expired. Sign in again.",
    });
  }
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- Only numeric nbf claims participate in the existing not-before check.
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_SECONDS > now) {
    return yield* new JwtError({ message: "The token is not valid yet." });
  }

  // eslint-disable-next-line anti-slop/no-runtime-typeof -- A nonempty string subject is required at the signed-payload boundary.
  if (typeof claims.sub !== "string" || claims.sub === "") {
    return yield* new JwtError({ message: "The token names no subject." });
  }
  return { ...claims, sub: claims.sub, exp: claims.exp };
});

function identity(claims: VerifiedClaims): Identity {
  return {
    sub: claims.sub,
    email:
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Optional email remains an untrusted claim; preserve its string-or-null representation.
      typeof claims.email === "string" && claims.email !== ""
        ? claims.email
        : null,
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- Optional client_id is exposed only when the signed payload contains a string.
    client_id: typeof claims.client_id === "string" ? claims.client_id : null,
    exp: claims.exp,
  };
}

export const verifyJwt = Effect.fn("jwt.verifyJwt")(function* (
  token: string,
  opts: { issuer: string; audience: string; jwks: Jwks }
): Effect.fn.Return<Identity, JwtError> {
  const claims = yield* verifiedClaims(token, opts);
  // The audience: a token is minted for one resource, and this endpoint
  // accepts only tokens minted for it. A token for another of the
  // authorization server's resources is refused here, whoever signed it.
  // Both values go in the sentence, because a mismatch is nearly always a
  // registration typo and the two strings side by side are the diagnosis.
  const audiences = (
    Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  ).filter((entry): entry is string => typeof entry === "string");
  const wanted = canonicalResource(opts.audience);
  if (!audiences.some((entry) => canonicalResource(entry) === wanted)) {
    return yield* new JwtError({
      message: `The token is for "${
        audiences.join(", ") || "no resource"
      }", not for this endpoint (${opts.audience}).`,
    });
  }

  return identity(claims);
});

// WorkOS web-session tokens name an application with client_id and a session
// with sid. Connect/MCP tokens name a resource with aud instead. Do not relax
// the connector's audience check to accept a web token, or accept a Connect
// token here merely because its subject belongs to Marco. A signed token stays
// valid until it expires, even after its WorkOS session is revoked.
export const verifyWebSessionJwt = Effect.fn("jwt.verifyWebSessionJwt")(
  function* (
    token: string,
    opts: { issuer: string; clientId: string; jwks: Jwks }
  ): Effect.fn.Return<Identity, JwtError> {
    const claims = yield* verifiedClaims(token, opts);
    if (
      claims.client_id !== opts.clientId ||
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- Web-session authentication requires a nonempty string sid from the signed payload.
      typeof claims.sid !== "string" ||
      claims.sid === "" ||
      claims.aud !== undefined ||
      claims.act !== undefined
    ) {
      return yield* new JwtError({
        message:
          "This endpoint requires a direct web session for this application, not a connector or impersonation token. Sign in to the dashboard again.",
      });
    }
    return identity(claims);
  }
);

// --- What the authorization server publishes, read rarely -------------------

// Two caches, one entry per URL each. The metadata names the key set; the
// key set holds the keys. Both change rarely — a key rotation is announced
// by a token naming a kid the key cache has not seen, which is the one event
// that refetches the keys early. Otherwise each is read once an hour, and a
// burst of tokens naming keys that do not exist refetches at most once a
// minute, so an unauthenticated caller cannot turn this into a request per
// call against the authorization server.
const CACHE_TTL_MS = 60 * 60 * 1000;
const REFETCH_INTERVAL_MS = 60 * 1000;
// A read of the metadata or the keys that has not answered in this long is
// treated as unreachable. Without a bound, a server that accepts the
// connection and never answers — or a name that never resolves — would hold
// the request open for as long as the runtime allows, and the caller would
// wait with it instead of being told to try again.
const FETCH_MS = 5000;
// One entry per configured URL; the bound only guards a misconfiguration.
const CAPACITY = 16;

interface Published<T> {
  readonly value: T;
  readonly fetchedAt: number;
}

function unreadable(
  what: "metadata" | "keys",
  url: string,
  reason: string
): AuthorizationServerError {
  return new AuthorizationServerError({
    message: `The authorization server's ${what} could not be read: ${url} ${reason}.`,
  });
}

// One read of a published document, headers and body within the deadline.
// The timeout interrupts the fetch, which aborts it through the signal. Its
// fields stay unknown until the reader of each document checks them.
const readPublished = Effect.fn("jwt.readPublished")(function* (
  what: "metadata" | "keys",
  url: string
): Effect.fn.Return<JsonObject | null, AuthorizationServerError> {
  const { ok, status, text } = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { signal });
      return {
        ok: response.ok,
        status: response.status,
        text: response.ok ? await response.text() : "",
      };
    },
    catch: () => unreadable(what, url, "could not be reached"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: FETCH_MS,
      orElse: () =>
        Effect.fail(
          unreadable(what, url, `timed out after ${FETCH_MS / 1000} seconds`)
        ),
    })
  );
  if (!ok) {
    return yield* unreadable(what, url, `answered ${status}`);
  }
  const json = yield* Effect.try({
    try: () => JSON.parse(text),
    catch: () => unreadable(what, url, "did not answer with JSON"),
  });
  return isJsonObject(json) ? json : null;
});

// Where an issuer publishes its metadata (RFC 8414 §3.1): the well-known
// segment goes between the host and the issuer's path, so an issuer with a
// path — https://x.example/auth/v1 — is described at
// https://x.example/.well-known/oauth-authorization-server/auth/v1, and one
// without a path at the well-known URL alone.
export function metadataUrl(
  issuer: string
): Effect.Effect<string, AuthorizationServerError> {
  return Effect.try({
    try: () => new URL(issuer),
    catch: () =>
      new AuthorizationServerError({
        message: `AUTH_ISSUER is not a URL: "${issuer}".`,
      }),
  }).pipe(
    Effect.map((parsed) => {
      const path = parsed.pathname.replace(/\/+$/u, "");
      return `${parsed.origin}/.well-known/oauth-authorization-server${path}`;
    })
  );
}

// A success is kept for an hour, a failure for a minute: the cooldown that
// stops a server that is down from being asked on every call. Concurrent
// reads of one URL share one fetch. The caches belong to the isolate, built
// once with no I/O, and read time from the Clock of whoever reads them.
function timeToLive<A, E>(exit: Exit.Exit<A, E>): number {
  return Exit.isSuccess(exit) ? CACHE_TTL_MS : REFETCH_INTERVAL_MS;
}

const metadataCache = Effect.runSync(
  Cache.makeWith(
    Effect.fn("jwt.readMetadata")(function* (
      issuer: string
    ): Effect.fn.Return<string, AuthorizationServerError> {
      const url = yield* metadataUrl(issuer);
      const body = yield* readPublished("metadata", url);
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- Issuer metadata is external JSON; only a string can declare its issuer.
      const declared = typeof body?.issuer === "string" ? body.issuer : "";
      if (declared.replace(/\/+$/u, "") !== issuer.replace(/\/+$/u, "")) {
        return yield* unreadable(
          "metadata",
          url,
          `names issuer "${declared}", not ${issuer}`
        );
      }
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- Validate the external metadata's nonempty JWKS URL before returning it.
      if (typeof body?.jwks_uri !== "string" || body.jwks_uri === "") {
        return yield* unreadable("metadata", url, "did not name a jwks_uri");
      }
      return body.jwks_uri;
    }),
    { capacity: CAPACITY, timeToLive }
  )
);

const readJwks = Effect.fn("jwt.readJwks")(function* (
  url: string
): Effect.fn.Return<Published<Jwks>, AuthorizationServerError> {
  const fetchedAt = yield* Clock.currentTimeMillis;
  const keys = (yield* readPublished("keys", url))?.keys;
  if (!Array.isArray(keys)) {
    return yield* unreadable("keys", url, "did not answer with a key set");
  }
  // The array is checked here; individual keys are checked at import.
  return { value: { keys }, fetchedAt };
});

const jwksCache = Effect.runSync(
  Cache.makeWith(readJwks, { capacity: CAPACITY, timeToLive })
);

// Bumped by forgetJwks, so a rotation still in flight across a reset cannot
// write its keys into the reset cache.
let generation = 0;

// A rotation refetch is its own entry, kept a minute whatever it answered:
// a burst of tokens naming unknown keys shares one request, and asks again
// at most once a minute. A rotation that fails refuses only the token that
// named the unknown key. The keys already held stay in the cache above, so
// every token signed with one of them keeps working through an outage of
// the authorization server until those keys expire.
const rotations = Effect.runSync(
  Cache.makeWith(
    (url: string) => {
      const started = generation;
      return readJwks(url).pipe(
        Effect.tap((published) =>
          generation === started
            ? Cache.set(jwksCache, url, published)
            : Effect.void
        )
      );
    },
    { capacity: CAPACITY, timeToLive: () => REFETCH_INTERVAL_MS }
  )
);

// The key set's address, learned from the issuer rather than assumed: every
// authorization server puts its keys somewhere different, and the metadata
// is where it says so.
export const discoverJwksUrl = Effect.fn("jwt.discoverJwksUrl")(function* (
  issuer: string
): Effect.fn.Return<string, AuthorizationServerError> {
  return yield* Cache.get(metadataCache, issuer);
});

export const fetchJwks = Effect.fn("jwt.fetchJwks")(function* (
  url: string,
  opts: { unknownKid?: string } = {}
): Effect.fn.Return<Jwks, AuthorizationServerError> {
  const cached = yield* Cache.get(jwksCache, url);
  const { unknownKid } = opts;
  if (
    unknownKid === undefined ||
    cached.value.keys.some((key) => key.kid === unknownKid)
  ) {
    return cached.value;
  }
  const now = yield* Clock.currentTimeMillis;
  if (now - cached.fetchedAt < REFETCH_INTERVAL_MS) {
    return cached.value;
  }
  // A key this cache has not seen, on keys read more than a minute ago: what
  // a rotation looks like from here.
  return (yield* Cache.get(rotations, url)).value;
});

// For the tests, which need cold caches between cases. A read still in
// flight finishes for its own callers and is not kept.
export function forgetJwks(): void {
  generation += 1;
  Effect.runSync(
    Effect.all([
      Cache.invalidateAll(jwksCache),
      Cache.invalidateAll(rotations),
      Cache.invalidateAll(metadataCache),
    ])
  );
}
