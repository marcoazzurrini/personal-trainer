import { WeightDataSchema } from "./weight.ts";
import type { WeightData } from "./weight.ts";

export type Dashboard =
  | { status: "signed-out" }
  | { status: "forbidden" }
  | { status: "unavailable"; message: string }
  | { status: "ready"; data: WeightData };

type Session =
  | { user: null }
  | {
      user: { id: string };
      accessToken: string;
      impersonator?: unknown;
    };

type ApiRequest = (input: URL, init: RequestInit) => Promise<Response>;

function apiOrigin(value: string): URL {
  const origin = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (
    (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Invalid origin");
  }
  return origin;
}

function apiFailureMessage(status: number): string {
  if (status === 401) {
    return "The API refused this session. Sign out and sign in again. If this persists, check the API's web authentication settings.";
  }
  if (status === 403) {
    return "The API does not allow this account to read the dashboard.";
  }
  return "The API could not load your weight history. Try again in a moment.";
}

// Only called inside a server function. Accept the middleware's verified
// session, never a browser-supplied user id or token. The returned union cannot
// carry credentials. The fixed path is intentionally not a general proxy.
export async function readDashboard(
  session: Session,
  env: NodeJS.ProcessEnv = process.env,
  request: ApiRequest = fetch
): Promise<Dashboard> {
  if (!session.user) {
    return { status: "signed-out" };
  }
  if (!env.ALLOWED_SUBJECT) {
    return {
      status: "unavailable",
      message: "Dashboard access is not configured.",
    };
  }
  if (session.user.id !== env.ALLOWED_SUBJECT || session.impersonator) {
    return { status: "forbidden" };
  }
  let origin: URL;
  try {
    origin = apiOrigin(env.TRAINER_API_ORIGIN ?? "");
  } catch {
    return {
      status: "unavailable",
      message: "The API origin is not configured correctly.",
    };
  }
  try {
    const response = await request(new URL("/api/bodyweight", origin), {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
      // Workers supports manual redirects, not redirect: "error". Refuse every
      // non-2xx response below rather than forwarding the token to another URL.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status: "unavailable",
        message: apiFailureMessage(response.status),
      };
    }
    const parsed = WeightDataSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        status: "unavailable",
        message:
          "The API returned an unexpected weight record. No chart was drawn.",
      };
    }
    return { status: "ready", data: parsed.data };
  } catch {
    // Never expose upstream bodies, tokens, URLs or provider errors to the UI.
    return {
      status: "unavailable",
      message:
        "Your weight history could not be loaded. Check your connection and try again.",
    };
  }
}
