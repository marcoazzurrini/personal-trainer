import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";

export default defineConfig({
  extends: [core, react, tanstack, antiSlop],
  rules: {
    // Keep hoisted helpers and arrows; changing declaration style is not a safety fix.
    "func-style": ["error", "declaration", { allowArrowFunctions: true }],
    "no-use-before-define": ["error", { functions: false }],
    "no-plusplus": ["error", { allowForLoopAfterthoughts: true }],
    // Reading a response property inline does not require a throwaway variable.
    "unicorn/no-await-expression-member": "off",
    // Database writes and fixture steps intentionally execute in order.
    "no-await-in-loop": "off",
    // Short invariant comments belong beside the operation they explain.
    "no-inline-comments": "off",
    // Node assertions and fast-check intentionally expose namespaced default APIs.
    "import/no-named-as-default-member": "off",
    "unicorn/filename-case": [
      "error",
      { cases: { kebabCase: true, snakeCase: true } },
    ],
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
  },
  overrides: [
    {
      // The API is written in Effect. These rules read Effect code as promise
      // code and misfire on its idioms; Effect code has no promise chains.
      files: ["apps/api/**"],
      rules: {
        // Effect.gen and Effect.fn bodies are generators; Effect.fn("name")
        // already names the work, and that name is the tracing span.
        "func-names": ["error", "always", { generators: "never" }],
        // Effect.catch is the Effect error handler, not Promise#catch.
        "promise/prefer-await-to-then": "off",
        // An Effect error handler takes the failure first; it is not a
        // Node-style callback, and its parameter names what it caught.
        "promise/prefer-await-to-callbacks": "off",
        "unicorn/catch-error-name": "off",
      },
    },
    {
      files: [
        "apps/api/tests/**/*_test.ts",
        "apps/api/tests/*.test.ts",
        "packages/db/tests/*.test.ts",
        "apps/api/tests/d1/*.test.ts",
        "apps/api/tests/d1/*.test.worker.ts",
        "apps/web/tests/**",
      ],
      rules: {
        // Tests check primitive representations and keep fixture helpers local.
        "anti-slop/no-runtime-typeof": "off",
        "unicorn/consistent-function-scoping": "off",
      },
    },
    {
      files: ["apps/web/tests/**"],
      rules: {
        // Preserve the existing Vitest seams that isolate server-only SDK modules.
        "anti-slop/no-module-mocking": "off",
      },
    },
  ],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    ".delta/**",
    ".pi/**",
    ".wrangler/**",
    "**/.output/**",
    "**/.tanstack/**",
    "**/test-results/**",
    "**/playwright-report/**",
    "apps/web/src/routeTree.gen.ts",
  ],
});
