import { timingSafeEqual } from "./jwt.ts";

// The in-app coach is a Worker with no sign-in of its own: it reaches the API
// over a service binding and carries one long-lived secret, held as a Worker
// secret on both sides and never shown to its model. It grants what a minted
// coach token grants. A configured value that could be mistaken for a JWT, or
// is too short to be a real secret, disables the credential rather than
// weakening it.
export const MIN_AGENT_TOKEN_LENGTH = 32;

export async function isCoachAgentToken(
  bearer: string,
  configured: string | undefined
): Promise<boolean> {
  if (
    configured === undefined ||
    configured.length < MIN_AGENT_TOKEN_LENGTH ||
    configured.includes(".")
  ) {
    return false;
  }
  return await timingSafeEqual(bearer, configured);
}
