// Native SQLite statements only. This bridge does not translate PostgreSQL,
// expose a transaction callback, or emulate a database connection.
import { management, verifiedDatabase } from "./disposable.ts";
import type { Database, Parameter, Result, Statement } from "../shared/d1.ts";
export interface Query {
  sql: string;
  params?: Parameter[];
}
export async function batch(queries: Query[]): Promise<Result[]> {
  const d = await verifiedDatabase();
  return management(d, "batch", { statements: queries });
}
export async function execute(
  sql: string,
  params: Parameter[] = [],
  // Test queries choose their own result columns dynamically.
  // deno-lint-ignore no-explicit-any
): Promise<any[]> {
  return (await batch([{ sql, params }]))[0].results;
}
export default function d1() {
  const query = (strings: TemplateStringsArray, ...params: Parameter[]) =>
    execute(strings.join("?"), params);
  query.unsafe = execute;
  query.end = () => Promise.resolve();
  return query;
}
class FixtureStatement implements Statement {
  constructor(readonly sql: string, readonly params: Parameter[] = []) {}
  bind(...params: Parameter[]): FixtureStatement {
    return new FixtureStatement(this.sql, params);
  }
  async all<T>(): Promise<Result<T>> {
    return (await batch([this]))[0] as Result<T>;
  }
}
// For direct persistence tests. Still executes on the real isolated D1 binding.
export const database: Database = {
  prepare(sql) {
    return new FixtureStatement(sql);
  },
  async batch<T>(statements: Statement[]): Promise<Result<T>[]> {
    if (statements.some((s) => !(s instanceof FixtureStatement))) {
      throw new Error("Foreign fixture statement.");
    }
    return await batch(statements as FixtureStatement[]) as Result<T>[];
  },
};
