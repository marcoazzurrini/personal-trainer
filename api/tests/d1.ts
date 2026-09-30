import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "@cloudflare/workers-types";
import { z } from "@hono/zod-openapi";

import type { Parameter, StoredRow } from "../../db/native.ts";
// Native SQLite statements only. This bridge does not translate PostgreSQL,
// expose a transaction callback, or emulate a database connection.
import { management, nativeStatement, verifiedDatabase } from "./disposable.ts";

export interface Query {
  sql: string;
  params?: Parameter[];
}
export async function batch<T = StoredRow>(
  queries: Query[]
): Promise<D1Result<T>[]> {
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
const parameters = z.array(z.union([z.string(), z.number(), z.null()]));
class FixtureStatement implements D1PreparedStatement {
  readonly sql: string;
  readonly params: Parameter[];

  constructor(sql: string, params: Parameter[] = []) {
    this.sql = sql;
    this.params = params;
  }
  bind(...params: unknown[]): FixtureStatement {
    const values = parameters.safeParse(params);
    if (!values.success) {
      throw new Error(
        "Fixture D1 bindings support only strings, finite numbers and null."
      );
    }
    return new FixtureStatement(this.sql, values.data);
  }
  async all<T = StoredRow>(): Promise<D1Result<T>> {
    return (await batch<T>([this]))[0];
  }
  run<T = StoredRow>(): Promise<D1Result<T>> {
    return nativeStatement({ ...this, method: "run" });
  }
  first<T = StoredRow>(column?: string): Promise<T | null> {
    return nativeStatement({ ...this, method: "first", column });
  }
  raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw<T = unknown[]>(options?: {
    columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    return nativeStatement({
      ...this,
      method: "raw",
      columnNames: options?.columnNames,
    });
  }
}
// For direct persistence tests. Still executes on the real isolated D1 binding.
export const database: D1Database = {
  prepare(sql) {
    return new FixtureStatement(sql);
  },
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const queries = statements.map((statement) => {
      if (!(statement instanceof FixtureStatement)) {
        throw new Error("Foreign fixture statement.");
      }
      return statement;
    });
    return await batch<T>(queries);
  },
  exec() {
    throw new Error("Fixture D1 exec is unsupported; use prepared statements.");
  },
  dump() {
    throw new Error("Fixture D1 dump is unsupported.");
  },
  withSession() {
    throw new Error("Fixture D1 sessions are unsupported.");
  },
};
