// Who may use the app: one person, signed in as themselves. Accept only the
// middleware's verified session, never a browser-supplied user id or token.

export type Access =
  | { status: "signed-out" }
  | { status: "forbidden" }
  | { status: "unavailable"; message: string }
  | { status: "ready" };

export type Session =
  | { user: null }
  | {
      user: { id: string };
      impersonator?: unknown;
    };

export function sessionAccess(
  session: Session,
  env: NodeJS.ProcessEnv = process.env
): Access {
  if (!session.user) {
    return { status: "signed-out" };
  }
  if (!env.ALLOWED_SUBJECT) {
    return {
      status: "unavailable",
      message: "Access to the app is not configured.",
    };
  }
  // Someone acting as Marco is still not Marco.
  if (session.user.id !== env.ALLOWED_SUBJECT || session.impersonator) {
    return { status: "forbidden" };
  }
  return { status: "ready" };
}
