import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  overrides: [
    ...(ultracite.overrides ?? []),
    {
      // Nitro's JSONC reader accepts comments but rejects trailing commas.
      files: ["apps/web/wrangler.jsonc"],
      options: { trailingComma: "none" },
    },
  ],
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    ".delta/**",
    ".pi/**",
    ".wrangler/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/.output/**",
    "**/.tanstack/**",
    "**/test-results/**",
    "**/playwright-report/**",
    "apps/web/src/routeTree.gen.ts",
    // Plugin frontmatter is an executable skill contract, not formatter input.
    "plugin/**",
  ],
});
