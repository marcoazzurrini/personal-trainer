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
      files: [
        "api/tests/**/*_test.ts",
        "scripts/tests/**/*.test.ts",
        "db/tests/*.test.ts",
        "db/tests/*.test.worker.ts",
        "web/tests/**",
      ],
      rules: {
        // Tests check primitive representations and keep fixture helpers local.
        "anti-slop/no-runtime-typeof": "off",
        "unicorn/consistent-function-scoping": "off",
      },
    },
    {
      files: ["web/tests/**"],
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
    "web/src/routeTree.gen.ts",
  ],
});
