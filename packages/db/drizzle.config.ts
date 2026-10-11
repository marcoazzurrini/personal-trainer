import { defineConfig } from "drizzle-kit";

// Offline schema tooling only. Runtime bindings and migration application stay
// with D1/Wrangler; this configuration neither loads env files nor credentials.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations",
});
