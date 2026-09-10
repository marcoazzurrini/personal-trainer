import { createFileRoute } from "@tanstack/react-router";
import { getSignInUrl } from "@workos/authkit-tanstack-react-start";

export const Route = createFileRoute("/auth/sign-in")({
  server: {
    handlers: {
      GET: async () =>
        Response.redirect(
          await getSignInUrl({ data: { returnPathname: "/" } }),
        ),
    },
  },
});
