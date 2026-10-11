import { z } from "zod";

import { COACH_CONVERSATION } from "./coach-path.ts";
import { sessionAccess } from "./session.server.ts";
import type { Session } from "./session.server.ts";

// The browser talks to one conversation, at one address, and only after the
// sign-in check. The coach Worker has no public address of its own: this is
// its only door, so the mapping below is the whole surface it exposes.
const COACH_ORIGIN = "https://trainer-coach.internal";
const CONVERSATION = "/agents/coach/main";

type Fetch = (request: Request) => Promise<Response>;

function refuse(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );
}

const Admission = z.looseObject({ streamUrl: z.string() });

/** The coach's address for a browser request, or null outside the surface. */
export function coachTarget(method: string, url: URL): URL | null {
  if (!url.pathname.startsWith(COACH_CONVERSATION)) {
    return null;
  }
  const rest = url.pathname.slice(COACH_CONVERSATION.length);
  const reading = method === "GET" || method === "HEAD";
  const allowed =
    (rest === "" && (reading || method === "POST")) ||
    (rest === "/abort" && method === "POST") ||
    (/^\/attachments\/[\w-]+$/u.test(rest) && reading);
  if (!allowed) {
    return null;
  }
  const target = new URL(`${CONVERSATION}${rest}`, COACH_ORIGIN);
  target.search = url.search;
  return target;
}

// Cookies and credentials stay at this door; the coach needs neither.
const withheld = new Set(["authorization", "cookie", "host"]);

export async function coachResponse(
  request: Request,
  session: Session,
  coach: Fetch | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<Response> {
  const access = sessionAccess(session, env);
  if (access.status === "signed-out") {
    return refuse(401, "Sign in to talk to your coach.");
  }
  if (access.status === "forbidden") {
    return refuse(403, "This account cannot use this app.");
  }
  if (access.status === "unavailable") {
    return refuse(503, access.message);
  }
  const target = coachTarget(request.method, new URL(request.url));
  if (target === null) {
    return refuse(404, "There is no such coach route.");
  }
  if (coach === undefined) {
    return refuse(503, "The coach is not connected to this app.");
  }
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!withheld.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  const forwarded = new Request(target, {
    method: request.method,
    headers,
    body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    redirect: "manual",
  });
  let response: Response;
  try {
    response = await coach(forwarded);
  } catch {
    return refuse(
      502,
      "The coach could not be reached. Try again in a moment."
    );
  }
  const returned = new Headers(response.headers);
  returned.delete("set-cookie");
  returned.set("Cache-Control", "private, no-store");
  // An admission names the conversation by the coach's own address, which the
  // browser cannot reach and the SDK checks against its client: name this one.
  if (
    request.method === "POST" &&
    target.pathname === CONVERSATION &&
    response.headers.get("content-type")?.includes("application/json")
  ) {
    const body: unknown = await response.json();
    const admission = Admission.safeParse(body);
    returned.delete("content-length");
    return Response.json(
      admission.success
        ? {
            ...admission.data,
            streamUrl: new URL(COACH_CONVERSATION, request.url).href,
          }
        : body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: returned,
      }
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: returned,
  });
}
