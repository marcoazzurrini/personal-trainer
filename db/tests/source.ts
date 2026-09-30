import { parse } from "@babel/parser";
import { traverseFast } from "@babel/types";
import type { Node } from "@babel/types";

export interface Dependency {
  target: string;
  typeOnly: boolean;
  line: number;
}

/** Parse source, not regular expressions over comments or SQL string contents. */
function visit(source: string, visitor: (node: Node) => void): void {
  traverseFast(
    parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] }),
    visitor
  );
}

function importedTarget(node: Node): string | undefined {
  if (
    node.type === "ImportDeclaration" ||
    node.type === "ExportNamedDeclaration" ||
    node.type === "ExportAllDeclaration"
  ) {
    return node.source?.value;
  }
  if (
    node.type === "CallExpression" &&
    (node.callee.type === "Import" ||
      (node.callee.type === "Identifier" && node.callee.name === "require"))
  ) {
    const [argument] = node.arguments;
    return argument?.type === "StringLiteral" ? argument.value : undefined;
  }
  if (
    node.type === "ImportExpression" &&
    node.source.type === "StringLiteral"
  ) {
    return node.source.value;
  }
  if (node.type === "TSImportType" && node.argument.type === "StringLiteral") {
    return node.argument.value;
  }
  return undefined;
}

function erased(node: Node): boolean {
  if (node.type === "ImportDeclaration") {
    return (
      node.importKind === "type" ||
      (node.specifiers.length > 0 &&
        node.specifiers.every(
          (item) =>
            item.type === "ImportSpecifier" && item.importKind === "type"
        ))
    );
  }
  if (node.type === "ExportNamedDeclaration") {
    return (
      node.exportKind === "type" ||
      (node.specifiers.length > 0 &&
        node.specifiers.every(
          (item) =>
            item.type === "ExportSpecifier" && item.exportKind === "type"
        ))
    );
  }
  if (node.type === "ExportAllDeclaration") {
    return node.exportKind === "type";
  }
  return node.type === "TSImportType";
}

export function dependencies(source: string): Dependency[] {
  const found: Dependency[] = [];
  visit(source, (node) => {
    const target = importedTarget(node);
    if (target !== undefined) {
      found.push({
        target,
        typeOnly: erased(node),
        line: node.loc?.start.line ?? 1,
      });
    }
  });
  return found;
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

export function queryViolations(file: string, source: string): string[] {
  const offenders: string[] = [];
  visit(source, (node) => {
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
  });
  return offenders;
}
