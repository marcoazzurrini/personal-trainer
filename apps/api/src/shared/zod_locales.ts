// Zod re-exports every message locale through one namespace, and
// @hono/zod-openapi hands Zod's whole `z` namespace to its extension, so the
// bundler cannot drop the ones nobody reads: about 250 KB of minified Worker,
// a third of it. The API writes its own messages (shared/schema.ts) and never
// selects a locale, so wrangler.jsonc aliases Zod's locale index to this one
// export. tests/bundle_test.ts fails if another locale reaches the build.
export { default as en } from "zod/v4/locales/en.js";
