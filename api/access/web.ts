import { ApiError } from "../shared/errors.ts";
import { fetchJwks, JwtError, readHeader, verifyWebSessionJwt } from "./jwt.ts";

// An explicit, optional second credential policy. No database access and no
// token minting: the web server forwards the user's short-lived WorkOS token.
// These settings are separate from Connect's issuer, audience and key set.
export async function authorizeWebRead(
  token: string,
  method: string,
  path: string,
): Promise<void> {
  const issuer = Deno.env.get("WEB_AUTH_ISSUER");
  const clientId = Deno.env.get("WEB_AUTH_CLIENT_ID");
  const jwksUrl = Deno.env.get("WEB_AUTH_JWKS_URL");
  const subject = Deno.env.get("ALLOWED_SUBJECT");
  if (!issuer || !clientId || !jwksUrl || !subject) {
    throw new ApiError(
      401,
      "Web access is not configured. Configure WEB_AUTH_ISSUER, WEB_AUTH_CLIENT_ID and WEB_AUTH_JWKS_URL on the API before using the dashboard.",
    );
  }

  let identity;
  try {
    const { kid } = readHeader(token);
    let jwks = await fetchJwks(jwksUrl);
    if (kid !== null && !jwks.keys.some((key) => key.kid === kid)) {
      jwks = await fetchJwks(jwksUrl, { unknownKid: kid });
    }
    identity = await verifyWebSessionJwt(token, { issuer, clientId, jwks });
  } catch (error) {
    if (error instanceof JwtError) {
      throw new ApiError(
        401,
        "Web session is invalid or expired. Sign in to the dashboard again.",
      );
    }
    throw new ApiError(
      503,
      "The authorization server could not be reached to check the web session. Try again in a moment.",
    );
  }
  if (identity.sub !== subject) {
    throw new ApiError(
      403,
      "This dashboard belongs to one person. This account is not allowed.",
    );
  }
  // Deliberately not 'all GETs': some operational reads may trigger work, and
  // new endpoints must not silently gain a second caller. Hono handles HEAD
  // through GET too, so check the actual method rather than the route handler.
  if (method !== "GET" || path !== "/api/bodyweight") {
    throw new ApiError(
      403,
      "Web sessions may only read GET /bodyweight relative to the API base URL. No change was made.",
    );
  }
}
