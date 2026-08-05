// Type definitions for the Supabase Edge Runtime (Deno.serve, env, etc.)
import "@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "@hono/hono";
import postgres from "postgres";

// DATABASE_URL is set explicitly per environment (locally in functions/.env,
// hosted as a secret pointing at the transaction-mode pooler). The injected
// SUPABASE_DB_URL is only a fallback — its local hostname contains
// underscores, which DNS resolution rejects.
// prepare: false — the transaction-mode pooler does not support prepared
// statements.
const dbUrl = Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
const sql = postgres(dbUrl!, { prepare: false });

const app = new Hono().basePath("/api");

// Registered before the token middleware on purpose: /health is public so the
// uptime monitor can ping it without credentials. The select is the point —
// database activity is what keeps the free project from being paused.
app.get("/health", async (c) => {
  await sql`select 1`;
  return c.json({ status: "ok" });
});

// One static bearer token on every coach-API endpoint.
app.use(async (c, next) => {
  const expected = Deno.env.get("API_TOKEN");
  if (!expected) {
    return c.json({ error: "API_TOKEN is not configured on the server." }, 500);
  }
  if (c.req.header("authorization") !== `Bearer ${expected}`) {
    return c.json({
      error:
        "Missing or wrong bearer token. Send an Authorization: Bearer <token> header.",
    }, 401);
  }
  await next();
});

app.notFound((c) =>
  c.json({ error: `No route for ${c.req.method} ${c.req.path}.` }, 404)
);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error. See function logs." }, 500);
});

Deno.serve(app.fetch);
