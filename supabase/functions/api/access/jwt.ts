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
// Import-free on purpose, like surfaces/github.ts: the unit tests sign tokens
// with keys they generate and run this file outside the edge runtime.

export class JwtError extends Error {
  // Set when the token names a key the key set does not hold. The caller may
  // refetch the keys once for that case — a rotated key is the ordinary
  // reason — and every other refusal is final.
  constructor(message: string, public readonly unknownKid = false) {
    super(message);
  }
}

export interface Jwks {
  keys: Array<JsonWebKey & { kid?: string }>;
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
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new JwtError("The token is not base64url.");
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
  } catch {
    throw new JwtError(`The token's ${what} is not JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JwtError(`The token's ${what} is not an object.`);
  }
  return parsed as Record<string, unknown>; // checked: the guard above
}

// The key is imported for the algorithm the header claims, and refused if
// its type does not fit that algorithm. That is the guard against algorithm
// confusion: a header cannot talk an RSA key into acting as an EC key or the
// reverse, because the wrong kind of key never reaches verify(). Only the
// fields that define the key are handed to importKey — a published key set
// carries alg, use and key_ops beside them, and WebCrypto is strict about
// extras.
async function importKey(jwk: JsonWebKey, alg: Alg): Promise<CryptoKey> {
  if (alg === "RS256") {
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) {
      throw new JwtError(
        "The token says RS256 but the key it names is not an RSA key.",
      );
    }
    return await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new JwtError(
      "The token says ES256 but the key it names is not a P-256 key.",
    );
  }
  return await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

function pickKey(jwks: Jwks, kid: string | null): JsonWebKey {
  if (kid !== null) {
    const match = jwks.keys.find((key) => key.kid === kid);
    if (match === undefined) {
      throw new JwtError(
        `The token is signed with key "${kid}", which the authorization server does not publish.`,
        true,
      );
    }
    return match;
  }
  // No kid: only unambiguous when there is one key to choose from.
  if (jwks.keys.length !== 1) {
    throw new JwtError(
      "The token names no signing key and the authorization server publishes more than one.",
    );
  }
  return jwks.keys[0];
}

// The header alone: the shape of the token and the algorithm it claims, read
// before any key is fetched or touched. A token claiming "none" or an HMAC
// algorithm is refused here, so no key material ever meets a signature it was
// not made for; and a caller can learn which key the token names before it
// goes looking for one.
export function readHeader(
  token: string,
): { alg: Alg; kid: string | null; segments: [string, string, string] } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwtError("The token is not three dot-separated segments.");
  }
  const header = decodeJson(parts[0], "header");
  if (!isAlg(header.alg)) {
    throw new JwtError(
      `The token is signed with "${
        String(header.alg)
      }"; only RS256 or ES256 is accepted.`,
    );
  }
  return {
    alg: header.alg,
    kid: typeof header.kid === "string" ? header.kid : null,
    segments: [parts[0], parts[1], parts[2]],
  };
}

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
  return `${parsed.origin}${
    parsed.pathname.replace(/\/+$/, "")
  }${parsed.search}`;
}

export async function verifyJwt(
  token: string,
  opts: { issuer: string; audience: string; jwks: Jwks; now?: number },
): Promise<Identity> {
  const { alg, kid, segments } = readHeader(token);
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  const key = await importKey(pickKey(opts.jwks, kid), alg);
  const signed = new TextEncoder().encode(
    `${headerSegment}.${payloadSegment}`,
  );
  const valid = await crypto.subtle.verify(
    alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5" }
      : { name: "ECDSA", hash: "SHA-256" },
    key,
    decodeBase64Url(signatureSegment),
    signed,
  );
  if (!valid) throw new JwtError("The token's signature does not verify.");

  const claims = decodeJson(payloadSegment, "payload");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== opts.issuer) {
    throw new JwtError(
      `The token was issued by "${
        String(claims.iss)
      }", not by this project's authorization server.`,
    );
  }
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS <= now) {
    throw new JwtError("The token has expired. Sign in again.");
  }
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_SECONDS > now) {
    throw new JwtError("The token is not valid yet.");
  }

  // The audience: a token is minted for one resource, and this endpoint
  // accepts only tokens minted for it. A token for another of the
  // authorization server's resources is refused here, whoever signed it.
  // Both values go in the sentence, because a mismatch is nearly always a
  // registration typo and the two strings side by side are the diagnosis.
  const audiences = (Array.isArray(claims.aud) ? claims.aud : [claims.aud])
    .filter((entry): entry is string => typeof entry === "string");
  const wanted = canonicalResource(opts.audience);
  if (!audiences.some((entry) => canonicalResource(entry) === wanted)) {
    throw new JwtError(
      `The token is for "${
        audiences.join(", ") || "no resource"
      }", not for this endpoint (${opts.audience}).`,
    );
  }

  if (typeof claims.sub !== "string" || claims.sub === "") {
    throw new JwtError("The token names no subject.");
  }
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" && claims.email !== ""
      ? claims.email
      : null,
    client_id: typeof claims.client_id === "string" ? claims.client_id : null,
    exp: claims.exp,
  };
}

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
const jwksCache = new Map<string, { jwks: Jwks; fetchedAt: number }>();
const metadataCache = new Map<string, { jwksUrl: string; fetchedAt: number }>();

// Where an issuer publishes its metadata (RFC 8414 §3.1): the well-known
// segment goes between the host and the issuer's path, so an issuer with a
// path — https://x.example/auth/v1 — is described at
// https://x.example/.well-known/oauth-authorization-server/auth/v1, and one
// without a path at the well-known URL alone.
export function metadataUrl(issuer: string): string {
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new Error(`AUTH_ISSUER is not a URL: "${issuer}".`);
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}/.well-known/oauth-authorization-server${path}`;
}

// The key set's address, learned from the issuer rather than assumed: every
// authorization server puts its keys somewhere different, and the metadata
// is where it says so. Throws a plain Error, never a JwtError: nothing here
// is a refusal of the token, only a failure to reach the server that could
// judge it, and the route answers those differently.
export async function discoverJwksUrl(
  issuer: string,
  opts: { now?: number } = {},
): Promise<string> {
  const now = opts.now ?? Date.now();
  const cached = metadataCache.get(issuer);
  if (cached !== undefined && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.jwksUrl;
  }
  const url = metadataUrl(issuer);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `The authorization server's metadata could not be read: ${url} answered ${response.status}.`,
    );
  }
  const body = (await response.json()) as {
    issuer?: unknown;
    jwks_uri?: unknown;
  } | null;
  const declared = typeof body?.issuer === "string" ? body.issuer : "";
  if (declared.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
    throw new Error(
      `The authorization server's metadata could not be read: ${url} names issuer "${declared}", not ${issuer}.`,
    );
  }
  if (typeof body?.jwks_uri !== "string" || body.jwks_uri === "") {
    throw new Error(
      `The authorization server's metadata could not be read: ${url} did not name a jwks_uri.`,
    );
  }
  metadataCache.set(issuer, { jwksUrl: body.jwks_uri, fetchedAt: now });
  return body.jwks_uri;
}

export async function fetchJwks(
  url: string,
  opts: { unknownKid?: string; now?: number } = {},
): Promise<Jwks> {
  const now = opts.now ?? Date.now();
  const cached = jwksCache.get(url);
  const fresh = cached !== undefined && now - cached.fetchedAt < CACHE_TTL_MS;
  const holdsKid = cached !== undefined &&
    (opts.unknownKid === undefined ||
      cached.jwks.keys.some((key) => key.kid === opts.unknownKid));
  const recentlyFetched = cached !== undefined &&
    now - cached.fetchedAt < REFETCH_INTERVAL_MS;
  if (cached !== undefined && fresh && (holdsKid || recentlyFetched)) {
    return cached.jwks;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `The authorization server's keys could not be read: ${url} answered ${response.status}.`,
    );
  }
  const body: unknown = await response.json();
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) {
    throw new Error(
      `The authorization server's keys could not be read: ${url} did not answer with a key set.`,
    );
  }
  const jwks: Jwks = { keys: keys as Jwks["keys"] }; // checked: an array; each key is checked at import
  jwksCache.set(url, { jwks, fetchedAt: now });
  return jwks;
}

// For the tests, which need cold caches between cases.
export function forgetJwks(): void {
  jwksCache.clear();
  metadataCache.clear();
}
