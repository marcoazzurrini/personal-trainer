// WorkOS's callback URL already identifies this dashboard's public origin.
// Use it before Start handles redirects or CSRF checks. The internal HTTP
// connection and caller-supplied Host/Forwarded headers are not authorities.
export function publicRequest(
  request: Request,
  redirectUri: string | undefined,
): Request {
  let callback: URL;
  try {
    callback = new URL(redirectUri ?? "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(
      callback.hostname,
    );
    if (
      (callback.protocol !== "https:" &&
        !(local && callback.protocol === "http:")) ||
      callback.username || callback.password ||
      callback.pathname !== "/auth/callback" || callback.search || callback.hash
    ) throw new Error();
  } catch {
    throw new Error(
      "WORKOS_REDIRECT_URI must be the dashboard's HTTPS /auth/callback URL (HTTP is allowed only on localhost).",
    );
  }

  const incoming = new URL(request.url);
  const url = new URL(callback.origin);
  // Assign path and query separately: a path beginning with // must not be
  // interpreted as another host. Leave the method, headers and body intact.
  url.pathname = incoming.pathname;
  url.search = incoming.search;
  return url.href === request.url ? request : new Request(url, request);
}
