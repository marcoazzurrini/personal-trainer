import { aliasStore } from "../../api/shared/aliases.ts";
import type { Database, Parameter, Statement } from "../../api/shared/d1.ts";
import { ApiError } from "../../api/shared/errors.ts";
import { exerciseStore } from "../../api/training/exercises.ts";
import { trainingStateStore } from "../../api/training/state.ts";
import { volumeStore } from "../../api/training/volume.ts";
// Synthetic local-only harness. No HTTP routes or provider credentials.
import { operationInput } from "./test-input.ts";

export default {
  async fetch(request: Request, env: { DB: Database }): Promise<Response> {
    try {
      const input = operationInput.parse(await request.json());
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
          const metadata = statements.map((s) => {
            const entry = prepared.get(s);
            if (!entry) {
              throw new Error("Test batch received an unwrapped statement.");
            }
            return entry;
          });
          const writes = metadata.some(({ sql }) =>
            /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)
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
      const store = Object.entries(stores).find(
        ([name]) => name === input.store
      )?.[1];
      if (!store) {
        throw new Error("Unknown test store.");
      }
      const operation = Object.entries(store).find(
        ([name]) => name === input.method
      )?.[1];
      if (!operation) {
        throw new Error("Unknown test method.");
      }
      // oxlint-disable-next-line anti-slop/no-reflect-apply -- Negative persistence tests intentionally pass unvalidated arguments to an own store method.
      const result = await Reflect.apply(operation, store, input.args);
      return Response.json(result ?? null);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error ? error.message : "Unknown test failure",
        },
        { status: error instanceof ApiError ? error.status : 500 }
      );
    }
  },
};
