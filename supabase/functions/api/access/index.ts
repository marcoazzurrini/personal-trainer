// Who may call the API: the sign-in the connector checks and the token it
// mints. The page where Marco says yes is not here — the function cannot
// serve HTML, so it lives in web/consent/. What the composition root mounts
// is one router, above the bearer-token middleware, because it carries its own
// credential — a Supabase sign-in token checked on every call, never the
// coach token. Mount order is the auth property, so it stays where the
// middleware is, in index.ts (body/index.ts says why at length).

export { mcp } from "./mcp.routes.ts";
