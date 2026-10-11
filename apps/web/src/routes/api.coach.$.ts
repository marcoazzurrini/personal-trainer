import { createFileRoute } from "@tanstack/react-router";

// Every request to the coach passes the same sign-in check as the page, then
// crosses the service binding; nothing else in the app can reach the coach.
async function handle({ request }: { request: Request }): Promise<Response> {
  const { getAuthKitContext } =
    await import("@workos/authkit-tanstack-react-start");
  const { coachResponse } = await import("../coach-proxy.server");
  const { coachBinding } = await import("../coach-binding.server");
  return await coachResponse(
    request,
    getAuthKitContext().auth(),
    await coachBinding()
  );
}

export const Route = createFileRoute("/api/coach/$")({
  server: { handlers: { GET: handle, HEAD: handle, POST: handle } },
});
