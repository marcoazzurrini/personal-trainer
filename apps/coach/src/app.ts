import { setProvider } from "@flue/runtime";
import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";

import { Coach } from "./agents/coach.ts";
import { openrouter } from "./provider.ts";

setProvider(openrouter);

// This Worker has no public address. The dashboard reaches it over a service
// binding after its own sign-in check, so a request that arrives here has
// already been authorized; the route map stays the one conversation surface.
const app = new Hono();

app.route("/agents/coach", createAgentRouter(Coach));

export default app;
