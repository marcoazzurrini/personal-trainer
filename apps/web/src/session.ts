import { createServerFn } from "@tanstack/react-start";

export const loadSession = createServerFn({ method: "GET" }).handler(
  async () => {
    const { getAuthKitContext } =
      await import("@workos/authkit-tanstack-react-start");
    const { sessionAccess } = await import("./session.server");
    return sessionAccess(getAuthKitContext().auth());
  }
);
