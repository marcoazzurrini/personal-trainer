// Synthetic local-only harness. No HTTP routes or provider credentials.
import { exerciseStore } from "../../api/training/exercises.ts";
import { trainingStateStore } from "../../api/training/state.ts";
import { volumeStore } from "../../api/training/volume.ts";
import { aliasStore } from "../../api/shared/aliases.ts";
import { ApiError } from "../../api/shared/errors.ts";
import {
  type Database,
  type Parameter,
  type Statement,
} from "../../api/shared/d1.ts";

export default {
  async fetch(request: Request, env: { DB: Database }): Promise<Response> {
    try {
      const input = (await request.json()) as {
        store: string;
        method: string;
        args: unknown[];
        now?: string;
        beforeWrite?: { sql: string; values?: Parameter[] };
        failReadback?: boolean;
      };
      let injected = false;
      const prepared = new WeakMap<
        Statement,
        { sql: string; native: Statement }
      >();
      const wrap = (sql: string, values: Parameter[] = []): Statement => {
        const native = env.DB.prepare(sql).bind(...values);
        const wrapped: Statement = {
          bind: (...next) => wrap(sql, next),
          all: <T>() => native.all<T>(),
        };
        prepared.set(wrapped, { sql, native });
        return wrapped;
      };
      const db: Database = {
        prepare: (sql) => wrap(sql),
        async batch<T>(statements: Statement[]) {
          const metadata = statements.map((s) => prepared.get(s)!);
          const writes = metadata.some(({ sql }) =>
            /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)
          );
          if (writes && input.beforeWrite && !injected) {
            injected = true;
            await env.DB.prepare(input.beforeWrite.sql)
              .bind(...(input.beforeWrite.values ?? []))
              .all();
          }
          const native = metadata.map((m) => m.native);
          if (writes && input.failReadback) {
            native.push(env.DB.prepare("SELECT abs(-9223372036854775808)"));
          }
          return await env.DB.batch<T>(native);
        },
      };
      const clock = () => new Date(input.now ?? "2026-08-30T12:00:00Z");
      const stores = {
        exercises: exerciseStore(db, clock),
        state: trainingStateStore(db, clock),
        volume: volumeStore(db, clock),
        exerciseAliases: aliasStore(db, "exercise"),
        foodAliases: aliasStore(db, "food"),
        mealAliases: aliasStore(db, "meal"),
      };
      if (!Object.hasOwn(stores, input.store)) {
        throw new Error("Unknown test store.");
      }
      const store = stores[
        input.store as keyof typeof stores
      ] as unknown as Record<string, (...args: unknown[]) => unknown>;
      if (!Object.hasOwn(store, input.method)) {
        throw new Error("Unknown test method.");
      }
      return Response.json((await store[input.method](...input.args)) ?? null);
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error
            ? error.message
            : "Unknown test failure",
        },
        { status: error instanceof ApiError ? error.status : 500 },
      );
    }
  },
};
