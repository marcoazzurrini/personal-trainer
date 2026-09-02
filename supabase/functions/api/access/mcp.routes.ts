import { type Context, Hono } from "@hono/hono";
import { ApiError } from "../shared/errors.ts";
import {
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
} from "./mcp.ts";

// The connector's endpoint. Mounted ahead of the bearer-token middleware,
// because what it carries is not the coach token but the token Supabase Auth
// issued when Marco signed in — checked here, on every call, against the keys
// the sign-in server publishes. A plain Hono router rather than OpenAPIHono:
// the document at /openapi.json is the surface behind the coach token, and
// the test that holds that line probes every path in it for a 401. This is
// another protocol under another credential, and its one credential-free
// route — the discovery document — must answer without any. So it is named
// in the auth matrix beside the Withings webhook instead, with what guards it.
export const mcp = new Hono();

interface Config {
  issuer: string;
  jwksUrl: string;
  allowedEmail: string;
  publicOrigin: string | null;
}

// Read per request, like the GitHub client's: the rest of the API works
// without a sign-in configured, and the error should say what is missing.
// AUTH_JWKS_URL exists for the local stack, where the browser reaches the
// sign-in server at one address and this container at another.
function config(): Config {
  const issuer = Deno.env.get("AUTH_ISSUER");
  const allowedEmail = Deno.env.get("ALLOWED_EMAIL");
  if (!issuer || !allowedEmail) {
    throw new ApiError(
      500,
      "Signing in needs AUTH_ISSUER and ALLOWED_EMAIL configured on the server.",
    );
  }
  const trimmed = issuer.replace(/\/$/, "");
  return {
    issuer: trimmed,
    jwksUrl: Deno.env.get("AUTH_JWKS_URL") ||
      `${trimmed}/.well-known/jwks.json`,
    allowedEmail,
    publicOrigin: Deno.env.get("PUBLIC_ORIGIN") || null,
  };
}

// Where this function is reached from outside. The gateway strips
// /functions/v1 before a request arrives, so the router sees /api/mcp and the
// public URL has to put the prefix back. The origin is the request's own
// unless PUBLIC_ORIGIN says otherwise — the override exists for the case the
// runtime sees a scheme or host the outside world does not.
function publicUrl(c: Context, cfg: Config, path: string): string {
  const origin = cfg.publicOrigin ?? new URL(c.req.url).origin;
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
          `Sign in first. This endpoint takes the token Supabase Auth issues after a sign-in; where to sign in is described at ${metadataUrl}.`,
      },
      401,
      { "WWW-Authenticate": challengeHeader(metadataUrl, false) },
    );
  }

  let identity: Identity;
  try {
    identity = await verify(bearer, cfg);
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
          "The sign-in server could not be reached to check the token. Try again in a moment.",
      },
      503,
    );
  }

  // One person. A valid sign-in by anyone else is refused without a
  // challenge, so the client does not loop back into a sign-in that will
  // only end here again.
  if (identity.email.toLowerCase() !== cfg.allowedEmail.toLowerCase()) {
    return c.json(
      {
        error:
          `This coach belongs to one person, and ${identity.email} is not them.`,
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

  const outcome = await handleMcp(message, { email: identity.email }, {
    issue: issueToken,
    baseUrl: publicUrl(c, cfg, c.req.path.replace(/\/mcp$/, "")),
    version: "1",
  });
  if (outcome.status === 202) return c.body(null, 202);
  return c.json(outcome.body, outcome.status);
});

// The header is read before any key is fetched, so a token that is not even
// the right shape is refused without a round trip. A key this function has
// not seen — what a rotation looks like from here — is fetched for once,
// and then the token is judged.
async function verify(token: string, cfg: Config): Promise<Identity> {
  const { kid } = readHeader(token);
  let jwks = await fetchJwks(cfg.jwksUrl);
  if (kid !== null && !jwks.keys.some((key) => key.kid === kid)) {
    jwks = await fetchJwks(cfg.jwksUrl, { unknownKid: kid });
  }
  return await verifyJwt(token, { issuer: cfg.issuer, jwks });
}
