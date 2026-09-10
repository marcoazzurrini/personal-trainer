import { createFileRoute } from "@tanstack/react-router";
import { handleCallbackRoute } from "@workos/authkit-tanstack-react-start";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: handleCallbackRoute({
        returnPathname: "/",
        onError: () =>
          new Response(
            "Sign-in failed. Return to the dashboard and try again.",
            {
              status: 400,
              headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "no-store",
              },
            },
          ),
      }),
    },
  },
});
