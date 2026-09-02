import { type Context, Hono } from "@hono/hono";
import { ApiError } from "../shared/errors.ts";
import {
  discoverJwksUrl,
  fetchJwks,
  type Identity,
  JwtError,
  readHeader,
  verifyJwt,
} from "./jwt.ts";
import { issueToken } from "./tokens.ts";
import {
  challengeHeader,
  handleMcp,
  protectedResourceMetadata,
  publicOrigin,
} from "./mcp.ts";

// The connector's endpoint. Mounted ahead of the bearer-token middleware,
// because what it carries is not the coach token but the access token the
// authorization server issued when Marco signed in — checked here, on every
// call, against the keys that server publishes. A plain Hono router rather than OpenAPIHono:
// the document at /openapi.json is the surface behind the coach token, and
// the test that holds that line probes every path in it for a 401. This is
// another protocol under another credential, and its one credential-free
// route — the discovery document — must answer without any. So it is named
// in the auth matrix beside the Withings webhook instead, with what guards it.
export const mcp = new Hono();

interface Config {
  issuer: string;
  jwksUrl: string | null;
  allowedSubject: string;
  publicOrigin: string | null;
}

// Read per request, like the GitHub client's: the rest of the API works
// without a sign-in configured, and the error should say what is missing.
// The key set's address is normally learned from the issuer's own metadata;
// AUTH_JWKS_URL overrides that, for an issuer whose metadata omits it or
// whose keys this container reaches at another address.
function config(): Config {
  const issuer = Deno.env.get("AUTH_ISSUER");
  const allowedSubject = Deno.env.get("ALLOWED_SUBJECT");
  if (!issuer || !allowedSubject) {
    throw new ApiError(
      500,
      "Signing in needs AUTH_ISSUER and ALLOWED_SUBJECT configured on the server.",
    );
  }
  const trimmed = issuer.replace(/\/$/, "");
  return {
    issuer: trimmed,
    jwksUrl: Deno.env.get("AUTH_JWKS_URL") || null,
    allowedSubject,
    publicOrigin: Deno.env.get("PUBLIC_ORIGIN") || null,
  };
}

// Where this function is reached from outside. The gateway strips
// /functions/v1 before a request arrives, so the router sees /api/mcp and the
// public URL has to put the prefix back; and it ends TLS, so the scheme is
// worked out rather than read (publicOrigin says how). PUBLIC_ORIGIN
// overrides both for the case neither rule fits.
function publicUrl(c: Context, cfg: Config, path: string): string {
  const url = new URL(c.req.url);
  const origin = cfg.publicOrigin ?? publicOrigin({
    protocol: url.protocol,
    hostname: url.hostname,
    host: url.host,
    forwardedProto: c.req.header("x-forwarded-proto") ?? null,
  });
  return `${origin}/functions/v1${path}`;
}

const NO_STREAM =
  "This endpoint speaks MCP over POST only; it offers no event stream and no session to end.";

mcp.get("/oauth-protected-resource", (c) => {
  const cfg = config();
  const resource = publicUrl(
    c,
    cfg,
    c.req.path.replace(/\/oauth-protected-resource$/, ""),
  );
  return c.json(protectedResourceMetadata(resource, cfg.issuer));
});

mcp.get("/", (c) => c.json({ error: NO_STREAM }, 405));
mcp.delete("/", (c) => c.json({ error: NO_STREAM }, 405));

mcp.post("/", async (c) => {
  const cfg = config();
  const resource = publicUrl(c, cfg, c.req.path);
  const metadataUrl = `${resource}/oauth-protected-resource`;

  const sent = c.req.header("authorization") ?? "";
  const bearer = sent.startsWith("Bearer ") ? sent.slice("Bearer ".length) : "";
  if (bearer === "") {
    return c.json(
      {
        error:
          `Sign in first. This endpoint takes the token the authorization server issues after a sign-in; where to sign in is described at ${metadataUrl}.`,
      },
      401,
      { "WWW-Authenticate": challengeHeader(metadataUrl, false) },
    );
  }

  let identity: Identity;
  try {
    identity = await verify(bearer, cfg, resource);
  } catch (err) {
    if (err instanceof JwtError) {
      return c.json({ error: err.message }, 401, {
        "WWW-Authenticate": challengeHeader(metadataUrl, true),
      });
    }
    // Not a refusal: the keys could not be read. No challenge, because
    // sending the client back to sign in would not help, and 503 because
    // the next attempt may well succeed.
    return c.json(
      {
        error:
          "The authorization server could not be reached to check the token. Try again in a moment.",
      },
      503,
    );
  }

  // One person. A valid sign-in by anyone else is refused without a
  // challenge, so the client does not loop back into a sign-in that will
  // only end here again.
  if (identity.sub !== cfg.allowedSubject) {
    return c.json(
      {
        error:
          `This coach belongs to one person, and ${identity.sub} is not them.`,
      },
      403,
    );
  }

  let message: unknown;
  try {
    message = await c.req.json();
  } catch {
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "The body is not JSON." },
      },
      400,
    );
  }

  const outcome = await handleMcp(message, { subject: identity.sub }, {
    issue: issueToken,
    baseUrl: publicUrl(c, cfg, c.req.path.replace(/\/mcp$/, "")),
    version: "1",
  });
  if (outcome.status === 202) return c.body(null, 202);
  return c.json(outcome.body, outcome.status);
});

// The header is read before anything is fetched, so a token that is not even
// the right shape is refused without a round trip. Then the issuer's
// metadata says where the keys are, the keys are read, a key this function
// has not seen — what a rotation looks like from here — is fetched for once,
// and the token is judged: signature, issuer, expiry, and that it was minted
// for this endpoint and no other.
async function verify(
  token: string,
  cfg: Config,
  audience: string,
): Promise<Identity> {
  const { kid } = readHeader(token);
  const jwksUrl = cfg.jwksUrl ?? await discoverJwksUrl(cfg.issuer);
  let jwks = await fetchJwks(jwksUrl);
  if (kid !== null && !jwks.keys.some((key) => key.kid === kid)) {
    jwks = await fetchJwks(jwksUrl, { unknownKid: kid });
  }
  return await verifyJwt(token, { issuer: cfg.issuer, audience, jwks });
}
