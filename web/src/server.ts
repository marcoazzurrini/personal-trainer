import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { publicRequest } from "./public-request.server.ts";
import { healthResponse } from "./health.server.ts";

export default createServerEntry({
  fetch(request, options) {
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
    return handler.fetch(incoming, options);
  },
});
