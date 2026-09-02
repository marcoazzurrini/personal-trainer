// Checking a sign-in token: is it ours, is it still good, and who is it for.
//
// The connector receives one of these on every call — the token Supabase Auth
// issued to Claude after Marco signed in with Google. Supabase signs them with
// an EC key (ES256) and publishes the public half at a JWKS URL, so the check
// is local: fetch the keys once, verify the signature with WebCrypto, read the
// claims. No round trip to the auth server per call, and no library — the
// whole of ES256 is one importKey and one verify.
//
// Import-free on purpose, like surfaces/github.ts: the unit tests sign tokens
// with a key they generate and run this file outside the edge runtime.

export class JwtError extends Error {
  // Set when the token names a key the JWKS does not hold. The caller may
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
  email: string;
  client_id: string | null;
  exp: number;
}

// Seconds either side of the clock a token may be, to absorb the drift
// between the auth server's clock and this one.
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

// The JWKS carries fields WebCrypto is strict about (alg, use, key_ops), so
// only the four that define a P-256 public key are handed to importKey.
async function importKey(jwk: JsonWebKey): Promise<CryptoKey> {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new JwtError("The signing key is not a P-256 key.");
  }
  return await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

function pickKey(jwks: Jwks, kid: unknown): JsonWebKey {
  if (typeof kid === "string") {
    const match = jwks.keys.find((key) => key.kid === kid);
    if (match === undefined) {
      throw new JwtError(
        `The token is signed with key "${kid}", which the sign-in server does not publish.`,
        true,
      );
    }
    return match;
  }
  // No kid: only unambiguous when there is one key to choose from.
  if (jwks.keys.length !== 1) {
    throw new JwtError(
      "The token names no signing key and the sign-in server publishes more than one.",
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
): { kid: string | null; segments: [string, string, string] } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwtError("The token is not three dot-separated segments.");
  }
  const header = decodeJson(parts[0], "header");
  if (header.alg !== "ES256") {
    throw new JwtError(
      `The token is signed with "${
        String(header.alg)
      }"; only ES256 is accepted.`,
    );
  }
  return {
    kid: typeof header.kid === "string" ? header.kid : null,
    segments: [parts[0], parts[1], parts[2]],
  };
}

export async function verifyJwt(
  token: string,
  opts: { issuer: string; jwks: Jwks; now?: number },
): Promise<Identity> {
  const { kid, segments } = readHeader(token);
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  const key = await importKey(pickKey(opts.jwks, kid));
  const signed = new TextEncoder().encode(
    `${headerSegment}.${payloadSegment}`,
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
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
      }", not by this project's sign-in server.`,
    );
  }
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS <= now) {
    throw new JwtError("The token has expired. Sign in again.");
  }
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_SECONDS > now) {
    throw new JwtError("The token is not valid yet.");
  }
  if (typeof claims.sub !== "string" || claims.sub === "") {
    throw new JwtError("The token names no subject.");
  }
  if (typeof claims.email !== "string" || claims.email === "") {
    throw new JwtError(
      "The token carries no email; the sign-in must request the email scope.",
    );
  }
  return {
    sub: claims.sub,
    email: claims.email,
    client_id: typeof claims.client_id === "string" ? claims.client_id : null,
    exp: claims.exp,
  };
}

// --- The published keys, fetched rarely --------------------------------------

// One entry per JWKS URL. The keys change when Supabase rotates them, which is
// rare and announced by a token naming a kid this cache has not seen; that is
// the one event that refetches early. Otherwise the keys are read once an
// hour, and a burst of tokens naming keys that do not exist refetches at most
// once a minute, so an unauthenticated caller cannot turn this into a request
// per call against the sign-in server.
const CACHE_TTL_MS = 60 * 60 * 1000;
const REFETCH_INTERVAL_MS = 60 * 1000;
const cache = new Map<string, { jwks: Jwks; fetchedAt: number }>();

export async function fetchJwks(
  url: string,
  opts: { unknownKid?: string; now?: number } = {},
): Promise<Jwks> {
  const now = opts.now ?? Date.now();
  const cached = cache.get(url);
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
      `The sign-in server's keys could not be read: ${url} answered ${response.status}.`,
    );
  }
  const body: unknown = await response.json();
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) {
    throw new Error(
      `The sign-in server's keys could not be read: ${url} did not answer with a key set.`,
    );
  }
  const jwks: Jwks = { keys: keys as Jwks["keys"] }; // checked: an array; each key is checked at import
  cache.set(url, { jwks, fetchedAt: now });
  return jwks;
}

// For the tests, which need a cold cache between cases.
export function forgetJwks(): void {
  cache.clear();
}
