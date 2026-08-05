// Type definitions for the Supabase Edge Runtime (Deno.serve, env, etc.)
import "@supabase/functions-js/edge-runtime.d.ts";

Deno.serve((_req: Request) => Response.json({ status: "ok" }));
