import type { Database, Parameter, Result, Statement } from "../shared/d1.ts";
// Native SQLite statements only. This bridge does not translate PostgreSQL,
// expose a transaction callback, or emulate a database connection.
import { management, verifiedDatabase } from "./disposable.ts";

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
  params: Parameter[] = []
  // Test queries choose their own result columns dynamically.
  // oxlint-disable-next-line typescript/no-explicit-any -- SQL fixtures select different columns; individual tests assert the returned values.
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
  readonly sql: string;
  readonly params: Parameter[];

  constructor(sql: string, params: Parameter[] = []) {
    this.sql = sql;
    this.params = params;
  }
  bind(...params: Parameter[]): FixtureStatement {
    return new FixtureStatement(this.sql, params);
  }
  async all<T>(): Promise<Result<T>> {
    // SAFETY: T is the caller's declared SQL row shape, not runtime validation; the fixture executes this statement on D1.
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
    // SAFETY: Every statement passed the instanceof check above. Row type T remains the caller's SQL contract, not a runtime check.
    return (await batch(statements as FixtureStatement[])) as Result<T>[];
  },
};
