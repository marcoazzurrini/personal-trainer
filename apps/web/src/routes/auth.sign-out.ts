import { createFileRoute } from "@tanstack/react-router";
import {
  getAuthkit,
  getAuthKitContext,
} from "@workos/authkit-tanstack-react-start";

export const Route = createFileRoute("/auth/sign-out")({
  server: {
    handlers: {
      POST: async () => {
        const session = getAuthKitContext().auth();
        const headers = new Headers({
          "Cache-Control": "no-store",
          "Clear-Site-Data": '"cache"',
        });
        let location = "/";
        if (session.user) {
          const result = await (await getAuthkit()).signOut(session.sessionId);
          location = result.logoutUrl;
          for (const [name, values] of Object.entries(result.headers ?? {})) {
            for (const value of Array.isArray(values) ? values : [values]) {
              headers.append(name, value);
            }
          }
        }
        headers.set("Location", location);
        // A document navigation also discards the Router's in-memory data.
        return new Response(null, { status: 303, headers });
      },
    },
  },
});
