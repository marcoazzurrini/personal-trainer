const { existsSync } = require("node:fs");
const path = require("node:path");

// Arithmetic may refuse a call, but must never reach the database, not even
// through another module. A listed file that disappears fails here, loudly,
// instead of leaving a rule that quietly matches nothing.
const pure = [
  "apps/api/src/body/trend.ts",
  "apps/api/src/nutrition/expenditure.ts",
  "apps/api/src/nutrition/rules.ts",
  "apps/api/src/shared/dates.ts",
  "apps/api/src/training/rules.ts",
  "apps/api/src/training/set_correction.ts",
];
for (const file of pure) {
  if (!existsSync(path.resolve(__dirname, file))) {
    throw new Error(`${file} is listed as pure but does not exist.`);
  }
}

// dependency-cruiser cannot read TypeScript 7, so swc parses the sources.
// Without a parser it reads nothing and still reports no violations. Loading
// swc here makes a missing or unsupported copy stop the run instead.
const swc = require("@swc/core");

if (!swc.version.startsWith("1.")) {
  throw new Error(
    `dependency-cruiser 18 reads TypeScript with @swc/core 1.x, not ${swc.version}.`
  );
}

// Code that can query: the client, raw SQL, schema, repositories and Drizzle
// itself. Drizzle's error classes only classify failures.
const queries =
  "^packages/db/src/(client|native)\\.ts$|^packages/db/src/(schema|repositories)/|(^|/)node_modules/drizzle-orm/(?!errors)";

// The dashboard's own import rules are in apps/web/tests/boundaries.test.ts.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      comment:
        "Persistence knows nothing of HTTP, the API, the dashboard or the coach.",
      from: { path: "^packages/db/" },
      name: "database-stands-alone",
      severity: "error",
      to: { path: "^(apps|plugin)/|(^|/)node_modules/(hono|@hono)/" },
    },
    {
      comment:
        "API code receives repositories from services.ts. Type-only imports describe them and are erased at build.",
      from: { path: "^apps/api/src/", pathNot: "^apps/api/src/services\\.ts$" },
      name: "api-reaches-the-database-through-services",
      severity: "error",
      to: {
        dependencyTypesNot: ["type-only"],
        path: "^packages/db/|(^|/)node_modules/drizzle-orm/",
        pathNot: "^packages/db/src/(errors|storage)\\.ts$",
      },
    },
    {
      comment: "Only the value helpers convert stored representations.",
      from: {
        path: "^apps/api/src/",
        pathNot: "^apps/api/src/(services|shared/values)\\.ts$",
      },
      name: "storage-conversion-stays-in-values",
      severity: "error",
      to: {
        dependencyTypesNot: ["type-only"],
        path: "^packages/db/src/storage\\.ts$",
      },
    },
    {
      comment: "Only the Worker entrypoints compose the services.",
      from: {
        path: "^apps/api/src/",
        pathNot: "^apps/api/src/(index|worker)\\.ts$",
      },
      name: "services-are-composed-at-the-entrypoint",
      severity: "error",
      to: {
        dependencyTypesNot: ["type-only"],
        path: "^apps/api/src/services\\.ts$",
      },
    },
    {
      from: {
        path: `^(${pure.map((file) => file.replaceAll(".", "\\.")).join("|")})$`,
      },
      name: "pure-arithmetic-never-reaches-the-database",
      severity: "error",
      to: { path: queries, reachable: true },
    },
    {
      comment:
        "Cross-workspace imports use the package name, such as @trainer/db.",
      from: { path: "^((?:apps|packages)/[^/]+)/" },
      name: "no-relative-cross-workspace-imports",
      severity: "error",
      to: { dependencyTypes: ["local"], pathNot: "^$1/" },
    },
    {
      from: {},
      name: "no-unresolved-imports",
      severity: "error",
      to: { couldNotResolve: true },
    },
    {
      comment:
        "Bun hoists every package, so an undeclared import works by accident until it does not.",
      from: {},
      name: "no-undeclared-external-dependencies",
      severity: "error",
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
  ],
  options: {
    builtInModules: { add: ["bun", "bun:test", "cloudflare:workers"] },
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      conditionNames: ["import", "require", "node", "default"],
      exportsFields: ["exports"],
    },
    exclude: {
      path: "^apps/[^/]+/(\\.output|\\.tanstack|\\.wrangler|dist|test-results)/|(^|/)routeTree\\.gen(\\.ts)?$",
    },
    // swc still tells type-only imports apart.
    parser: "swc",
    tsPreCompilationDeps: true,
  },
};
