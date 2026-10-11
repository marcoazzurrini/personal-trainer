import { Config, Effect, Option } from "effect";

import { Forbidden, Unauthorized, Unavailable } from "../shared/refusals.ts";
import {
  fetchJwks,
  readHeader,
  timingSafeEqual,
  verifyWebSessionJwt,
} from "./jwt.ts";

// An explicit, optional second credential policy. No database access and no
// token minting: the web server forwards the user's short-lived WorkOS token.
// These settings are separate from Connect's issuer, audience and key set.
export interface WebAuthConfig {
  issuer?: string;
  clientId?: string;
  jwksUrl?: string;
  allowedSubject?: string;
}

function binding(name: string): Config.Config<string | undefined> {
  return Config.option(Config.String(name)).pipe(
    Config.map(Option.getOrUndefined)
  );
}

/** The dashboard's settings as this invocation's bindings state them. */
export const webAuthConfig: Config.Config<WebAuthConfig> = Config.all({
  issuer: binding("WEB_AUTH_ISSUER"),
  clientId: binding("WEB_AUTH_CLIENT_ID"),
  jwksUrl: binding("WEB_AUTH_JWKS_URL"),
  allowedSubject: binding("ALLOWED_SUBJECT"),
});

const unavailable = Effect.fail(
  new Unavailable({
    message:
      "The authorization server could not be reached to check the web session. Try again in a moment.",
  })
);

export const authorizeWebRead = Effect.fn("web.authorizeWebRead")(function* (
  token: string,
  method: string,
  path: string,
  config: Config.Config<WebAuthConfig>
): Effect.fn.Return<void, Unauthorized | Forbidden | Unavailable> {
  // A binding of the wrong type is a deployment bug, not a refusal.
  const {
    issuer,
    clientId,
    jwksUrl,
    allowedSubject: subject,
  } = yield* config.pipe(Effect.orDie);
  if (!issuer || !clientId || !jwksUrl || !subject) {
    return yield* new Unauthorized({
      message:
        "Web access is not configured. Configure WEB_AUTH_ISSUER, WEB_AUTH_CLIENT_ID and WEB_AUTH_JWKS_URL on the API before using the dashboard.",
    });
  }

  const identity = yield* Effect.gen(function* () {
    const { kid } = yield* readHeader(token);
    let jwks = yield* fetchJwks(jwksUrl);
    if (kid !== null && !jwks.keys.some((key) => key.kid === kid)) {
      jwks = yield* fetchJwks(jwksUrl, { unknownKid: kid });
    }
    return yield* verifyWebSessionJwt(token, { issuer, clientId, jwks });
  }).pipe(
    Effect.catchTag("JwtError", () =>
      Effect.fail(
        new Unauthorized({
          message:
            "Web session is invalid or expired. Sign in to the dashboard again.",
        })
      )
    ),
    // Anything but a refusal of the token — keys that could not be read, or
    // could not be used — is the authorization server being out of reach.
    Effect.catchTag("AuthorizationServerError", () => unavailable),
    Effect.catchDefect(() => unavailable)
  );
  if (!(yield* Effect.promise(() => timingSafeEqual(identity.sub, subject)))) {
    return yield* new Forbidden({
      message:
        "This dashboard belongs to one person. This account is not allowed.",
    });
  }
  // Deliberately not 'all GETs': some operational reads may trigger work, and
  // new endpoints must not silently gain a second caller. Hono handles HEAD
  // through GET too, so check the actual method rather than the route handler.
  if (method !== "GET" || path !== "/api/bodyweight") {
    return yield* new Forbidden({
      message:
        "Web sessions may only read GET /bodyweight relative to the API base URL. No change was made.",
    });
  }
});

/** Bind server configuration explicitly; omitted settings disable dashboard access. */
export function createWebAuthorizer(config: WebAuthConfig) {
  return (token: string, method: string, path: string) =>
    authorizeWebRead(token, method, path, Config.succeed(config));
}
