import type { Context } from "@hono/hono";
import type { Services } from "../services.ts";
import type { Diagnostic } from "./errors.ts";

export type AppEnv = {
  Variables: { services: Services; diagnostic: Diagnostic };
};

export function services(c: Context<AppEnv>): Services {
  return c.get("services");
}
