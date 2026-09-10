import { WeightData } from "./weight";

export type Dashboard =
  | { status: "signed-out" }
  | { status: "forbidden" }
  | { status: "unavailable"; message: string }
  | { status: "ready"; data: WeightData };

type Session = { user: null } | {
  user: { id: string };
  accessToken: string;
  impersonator?: unknown;
};

// Only called inside a server function. Accept the middleware's verified
// session, never a browser-supplied user id or token. The returned union cannot
// carry credentials. The fixed path is intentionally not a general proxy.
export async function readDashboard(
  session: Session,
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): Promise<Dashboard> {
  if (!session.user) return { status: "signed-out" };
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
    origin = new URL(env.TRAINER_API_ORIGIN ?? "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (
      (origin.protocol !== "https:" &&
        !(local && origin.protocol === "http:")) ||
      origin.username || origin.password || origin.pathname !== "/" ||
      origin.search || origin.hash
    ) throw new Error("Invalid origin");
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
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status: "unavailable",
        message: response.status === 401
          ? "The API refused this session. Sign out and sign in again. If this persists, check the API's web authentication settings."
          : response.status === 403
          ? "The API does not allow this account to read the dashboard."
          : "The API could not load your weight history. Try again in a moment.",
      };
    }
    const parsed = WeightData.safeParse(await response.json());
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
