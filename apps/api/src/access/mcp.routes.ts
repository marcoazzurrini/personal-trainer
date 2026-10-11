import { Config, Effect, Option } from "effect";
import { Hono } from "hono";
import type { Context } from "hono";

import { Misconfigured } from "../shared/refusals.ts";
import { run } from "../shared/services.ts";
import type { AppEnv } from "../shared/services.ts";
import {
  discoverJwksUrl,
  fetchJwks,
  readHeader,
  timingSafeEqual,
  verifyJwt,
} from "./jwt.ts";
import type { AuthorizationServerError, Identity, JwtError } from "./jwt.ts";
import type { McpDeps } from "./mcp.ts";
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
export interface McpConfig {
  issuer?: string;
  jwksUrl?: string | null;
  allowedSubject?: string;
  publicOrigin?: string | null;
}

type Settings = Required<McpConfig> & {
  issuer: string;
  allowedSubject: string;
};

function binding(name: string): Config.Config<string | undefined> {
  return Config.option(Config.String(name)).pipe(
    Config.map(Option.getOrUndefined)
  );
}

/** The sign-in configuration as this invocation's bindings state it. */
export const mcpConfig: Config.Config<McpConfig> = Config.all({
  issuer: binding("AUTH_ISSUER"),
  jwksUrl: binding("AUTH_JWKS_URL"),
  allowedSubject: binding("ALLOWED_SUBJECT"),
  publicOrigin: binding("PUBLIC_ORIGIN"),
});

// Read per request, like the GitHub client's: the rest of the API works
// without a sign-in configured, and the error should say what is missing.
// The key set's address is normally learned from the issuer's own metadata;
// AUTH_JWKS_URL overrides that, for an issuer whose metadata omits it or
// whose keys this container reaches at another address.
const settings = Effect.fn("mcp.settings")(function* (
  config: Config.Config<McpConfig>
): Effect.fn.Return<Settings, Misconfigured> {
  // A binding of the wrong type is a deployment bug, not a refusal.
  const input = yield* config.pipe(Effect.orDie);
  const { issuer, allowedSubject } = input;
  if (!issuer || !allowedSubject) {
    return yield* new Misconfigured({
      message:
        "Signing in needs AUTH_ISSUER and ALLOWED_SUBJECT configured on the server.",
    });
  }
  const trimmed = issuer.replace(/\/$/u, "");
  return {
    issuer: trimmed,
    jwksUrl: input.jwksUrl || null,
    allowedSubject,
    publicOrigin: input.publicOrigin || null,
  };
});

// Where this API is reached from outside. The proxy in front ends TLS, so
// the scheme is worked out rather than read (publicOrigin says how); the path
// is the one the router saw, since nothing strips a prefix on the way in.
// PUBLIC_ORIGIN overrides the origin for the case the rule does not fit.
function publicUrl(c: Context, cfg: Settings, path: string): string {
  const url = new URL(c.req.url);
  const origin =
    cfg.publicOrigin ??
    publicOrigin({
      protocol: url.protocol,
      hostname: url.hostname,
      host: url.host,
      forwardedProto: c.req.header("x-forwarded-proto") ?? null,
    });
  return `${origin}${path}`;
}

const NO_STREAM =
  "This endpoint speaks MCP over POST only; it offers no event stream and no session to end.";

// The header is read before anything is fetched, so a token that is not even
// the right shape is refused without a round trip. Then the issuer's
// metadata says where the keys are, the keys are read, a key this function
// has not seen — what a rotation looks like from here — is fetched for once,
// and the token is judged: signature, issuer, expiry, and that it was minted
// for this endpoint and no other.
const verify = Effect.fn("mcp.verify")(function* (
  token: string,
  cfg: Settings,
  audience: string
): Effect.fn.Return<Identity, JwtError | AuthorizationServerError> {
  const { kid } = yield* readHeader(token);
  const jwksUrl = cfg.jwksUrl ?? (yield* discoverJwksUrl(cfg.issuer));
  let jwks = yield* fetchJwks(jwksUrl);
  if (kid !== null && !jwks.keys.some((key) => key.kid === kid)) {
    jwks = yield* fetchJwks(jwksUrl, { unknownKid: kid });
  }
  return yield* verifyJwt(token, { issuer: cfg.issuer, audience, jwks });
});

/** Build per request with its token store; the composition root mounts /api/mcp. */
export function createMcpRoutes<E>(
  config: Config.Config<McpConfig>,
  deps: { issueToken: McpDeps<E>["issue"] }
) {
  const mcp = new Hono<AppEnv>();
  mcp.get("/oauth-protected-resource", async (c) => {
    const cfg = await run(c, settings(config));
    const resource = publicUrl(
      c,
      cfg,
      c.req.path.replace(/\/oauth-protected-resource$/u, "")
    );
    return c.json(protectedResourceMetadata(resource, cfg.issuer));
  });

  mcp.delete("/", (c) => c.json({ error: NO_STREAM }, 405));

  // Codex discovers OAuth with GET; Claude encounters it on POST. Both must
  // receive the same challenge before GET is refused for having no stream.
  mcp.on(
    ["GET", "POST"],
    "/",
    async (c) =>
      await run(
        c,
        Effect.gen(function* () {
          const cfg = yield* settings(config);
          const resource = publicUrl(c, cfg, c.req.path);
          const metadataUrl = `${resource}/oauth-protected-resource`;

          const sent = c.req.header("authorization") ?? "";
          const bearer = sent.startsWith("Bearer ")
            ? sent.slice("Bearer ".length)
            : "";
          if (bearer === "") {
            return c.json(
              {
                error: `Sign in first. This endpoint takes the token the authorization server issues after a sign-in; where to sign in is described at ${metadataUrl}.`,
              },
              401,
              { "WWW-Authenticate": challengeHeader(metadataUrl, false) }
            );
          }

          const verdict = yield* verify(bearer, cfg, resource).pipe(
            Effect.map((identity) => ({ identity })),
            Effect.catchTag("JwtError", (error) =>
              Effect.succeed({ refused: error.message })
            ),
            // Not a refusal: the keys could not be read, or could not be
            // used. No challenge, because sending the client back to sign in
            // would not help, and 503 because the next attempt may well
            // succeed.
            Effect.catchTag("AuthorizationServerError", () =>
              Effect.succeed({ unreachable: true })
            ),
            Effect.catchDefect(() => Effect.succeed({ unreachable: true }))
          );
          if ("refused" in verdict) {
            return c.json({ error: verdict.refused }, 401, {
              "WWW-Authenticate": challengeHeader(metadataUrl, true),
            });
          }
          if ("unreachable" in verdict) {
            return c.json(
              {
                error:
                  "The authorization server could not be reached to check the token. Try again in a moment.",
              },
              503
            );
          }
          const { identity } = verdict;

          // One person. A valid sign-in by anyone else is refused without a
          // challenge, so the client does not loop back into a sign-in that will
          // only end here again.
          if (
            !(yield* Effect.promise(() =>
              timingSafeEqual(identity.sub, cfg.allowedSubject)
            ))
          ) {
            return c.json(
              {
                error: `This coach belongs to one person, and ${identity.sub} is not them.`,
              },
              403
            );
          }

          if (c.req.method === "GET") {
            return c.json({ error: NO_STREAM }, 405);
          }

          const message = yield* Effect.tryPromise(() => c.req.json()).pipe(
            Effect.option
          );
          if (Option.isNone(message)) {
            return c.json(
              {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32_700, message: "The body is not JSON." },
              },
              400
            );
          }

          const outcome = yield* handleMcp(
            message.value,
            { subject: identity.sub },
            {
              issue: deps.issueToken,
              baseUrl: publicUrl(c, cfg, c.req.path.replace(/\/mcp$/u, "")),
              version: "1",
            }
          );
          if (outcome.status === 202) {
            return c.body(null, 202);
          }
          return c.json(outcome.body, outcome.status);
        })
      )
  );

  return mcp;
}
