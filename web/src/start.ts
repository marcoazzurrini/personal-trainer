import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { authkitMiddleware } from "@workos/authkit-tanstack-react-start";
import { loadDashboard } from "./dashboard";

const privateResponses = createMiddleware().server(
  async ({ next, handlerType, request }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    setResponseHeader("Referrer-Policy", "no-referrer");
    setResponseHeader("X-Content-Type-Options", "nosniff");
    setResponseHeader("X-Frame-Options", "DENY");
    // The SDK also compiles token-returning RPC helpers, even when the UI never
    // imports them. Only our data-only function is an HTTP entry point. SDK
    // helpers used internally by sign-in routes still run on the server.
    if (
      handlerType === "serverFn" && (
        new URL(request.url).pathname !==
          new URL(loadDashboard.url, request.url).pathname
      )
    ) {
      return new Response(
        "This server function is not exposed by the dashboard.",
        { status: 403 },
      );
    }
    return await next();
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [
    privateResponses,
    createCsrfMiddleware({
      filter: (ctx) =>
        ctx.handlerType === "serverFn" || ctx.request.method === "POST",
    }),
    authkitMiddleware(),
  ],
}));
