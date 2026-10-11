import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import { parse } from "@babel/parser";
import { traverseFast } from "@babel/types";
import type { Node } from "@babel/types";

import { assert, assertEquals } from "./assertions.ts";

// Import rules live in .dependency-cruiser.cjs. These look inside the code:
// repositories in @trainer/db own every query, so API code holds no SQL text
// and never touches the raw D1 binding.
const SOURCE = "apps/api/src";

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await files(path)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found.toSorted();
}

function literalText(node: Node): string | undefined {
  if (node.type === "StringLiteral") {
    return node.value;
  }
  if (node.type === "TemplateElement") {
    return node.value.raw;
  }
  return undefined;
}

function propertyName(node: Node): string | undefined {
  if (
    node.type !== "MemberExpression" &&
    node.type !== "OptionalMemberExpression"
  ) {
    return undefined;
  }
  if (node.property.type === "Identifier" && !node.computed) {
    return node.property.name;
  }
  return node.property.type === "StringLiteral"
    ? node.property.value
    : undefined;
}

/** Parse source, not regular expressions over comments or unrelated strings. */
function queryViolations(file: string, source: string): string[] {
  const offenders: string[] = [];
  traverseFast(
    parse(source, { sourceType: "module", plugins: ["typescript"] }),
    (node) => {
      const literal = literalText(node);
      const sql =
        literal !== undefined &&
        /^\s*(?:SELECT\s|INSERT\s+INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s|WITH\s+(?:RECURSIVE\s+)?\w+\s+AS\s*\()/iu.test(
          literal
        );
      const name = propertyName(node);
      const native =
        name !== undefined &&
        ["prepare", "$client", "batch", "transaction"].includes(name);
      if (sql || native) {
        offenders.push(`${file}:${node.loc?.start.line ?? 1}`);
      }
    }
  );
  return offenders;
}

test("API code holds no SQL and calls no raw D1 method", async () => {
  const offenders: string[] = [];
  for (const file of await files(SOURCE)) {
    offenders.push(...queryViolations(file, await readFile(file, "utf-8")));
  }
  assertEquals(offenders, [], "Repositories in @trainer/db own every query.");
});

test("route files never reach the D1 binding", async () => {
  const routes = (await files(SOURCE)).filter((file) =>
    file.endsWith(".routes.ts")
  );
  assert(routes.length > 0, `No *.routes.ts found under ${SOURCE}.`);
  const offenders: string[] = [];
  for (const file of routes) {
    const source = await readFile(file, "utf-8");
    for (const [line, text] of source.split("\n").entries()) {
      if (!text.trimStart().startsWith("//") && /\.DB\b/u.test(text)) {
        offenders.push(`${file}:${line + 1}`);
      }
    }
  }
  assertEquals(offenders, [], "Routes call application services.");
});

test("the SQL check sees queries, raw calls and comments apart", () => {
  assertEquals(
    queryViolations(
      "fixture.ts",
      'const a = "SELECT 1";\nenv.DB.prepare(a);\n// SELECT in a comment\n'
    ),
    ["fixture.ts:1", "fixture.ts:2"]
  );
});
