import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { publicRequest } from "./public-request.server.ts";
import { healthResponse } from "./health.server.ts";

export default createServerEntry({
  async fetch(request, options) {
    let incoming: Request;
    try {
      incoming = publicRequest(request, process.env.WORKOS_REDIRECT_URI);
    } catch {
      return new Response(
        "The dashboard address is not configured correctly.",
        {
          status: 503,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "private, no-store",
          },
        },
      );
    }
    if (new URL(incoming.url).pathname === "/api/health") {
      return healthResponse(incoming);
    }
    let response: Response;
    try {
      response = await handler.fetch(incoming, options);
    } catch {
      response = new Response("The dashboard could not handle this request.", {
        status: 500,
      });
    }
    // Redirect responses can bypass Start's response-header middleware. Enforce
    // privacy at the entry boundary too, including auth redirects and errors.
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
});
