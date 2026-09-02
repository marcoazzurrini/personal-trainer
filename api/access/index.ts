// Who may call the API: the sign-in the connector checks and the token it
// mints. Nothing here renders a page: the sign-in and the consent screen are
// the authorization server's, which is why the function needs no HTML at
// all. What the composition root mounts is one router, above the bearer-token
// middleware, because it carries its own credential — the access token the
// authorization server issued at sign-in, checked on every call, never the
// coach token. Mount order is the auth property, so it stays where the
// middleware is, in index.ts (body/index.ts says why at length).

export { mcp } from "./mcp.routes.ts";
