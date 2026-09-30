import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";

import { aliasStore } from "../../api/shared/aliases.ts";
import { ApiError, databaseError } from "../../api/shared/errors.ts";
import { exerciseStore } from "../../api/training/exercises.ts";
import { trainingResolver } from "../../api/training/resolve.ts";
import { trainingStateStore } from "../../api/training/state.ts";
import { contextStore } from "../../api/training/user_context.ts";
import { volumeStore } from "../../api/training/volume.ts";
import { createClient } from "../client.ts";
import { aliasRepository } from "../repositories/aliases.ts";
import { trainingRepositories } from "../repositories/training/index.ts";
// Synthetic local-only harness. No HTTP routes or provider credentials.
import { operationInput } from "./test-input.ts";

export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    try {
      const input = operationInput.parse(await request.json());
      let injected = false;
      const prepared = new WeakMap<
        D1PreparedStatement,
        { sql: string; native: D1PreparedStatement }
      >();
      const wrap = (
        sql: string,
        values: unknown[] = []
      ): D1PreparedStatement => {
        const native = env.DB.prepare(sql).bind(...values);
        const wrapped: D1PreparedStatement = {
          bind: (...next) => wrap(sql, next),
          all: <T>() => native.all<T>(),
          run: <T>() => native.run<T>(),
          first: native.first.bind(native),
          raw: native.raw.bind(native),
        };
        prepared.set(wrapped, { sql, native });
        return wrapped;
      };
      const db: D1Database = {
        prepare: (sql) => wrap(sql),
        async batch<T>(statements: D1PreparedStatement[]) {
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
        exec() {
          throw new Error("Test D1 exec is unsupported.");
        },
        dump() {
          throw new Error("Test D1 dump is unsupported.");
        },
        withSession() {
          throw new Error("Test D1 sessions are unsupported.");
        },
      };
      const clock = () => new Date(input.now ?? "2026-08-30T12:00:00Z");
      const client = createClient(db);
      const repositories = trainingRepositories(client);
      const resolver = trainingResolver(repositories.resolution);
      const exerciseAliases = aliasStore(aliasRepository(client, "exercise"));
      const stores = {
        exercises: exerciseStore(
          repositories.exercises,
          resolver,
          exerciseAliases,
          clock
        ),
        state: trainingStateStore(
          repositories.state,
          contextStore(repositories.context, clock),
          clock
        ),
        volume: volumeStore(repositories.volume, resolver, clock),
        exerciseAliases,
        foodAliases: aliasStore(aliasRepository(client, "food")),
        mealAliases: aliasStore(aliasRepository(client, "meal")),
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
      const mapped = databaseError(error);
      return Response.json(
        {
          error:
            error instanceof Error ? error.message : "Unknown test failure",
        },
        { status: mapped instanceof ApiError ? mapped.status : 500 }
      );
    }
  },
};
