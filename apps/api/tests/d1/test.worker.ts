import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import { jsonChunks } from "@trainer/db/write.ts";
import { Effect } from "effect";

import { createServices } from "../../src/services.ts";
import { refusalOf } from "../../src/shared/errors.ts";
import { invocationContext, run } from "../../src/shared/runtime.ts";
import type { Invocation } from "../../src/shared/runtime.ts";
import { fixedClock, instant } from "../../src/shared/values.ts";
// Local test harness, not a deployable API. It deliberately bypasses HTTP
// schemas to exercise persistence under workerd, with synthetic records only.
import { operationInput } from "./test-input.ts";

export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    try {
      const input = operationInput.parse(await request.json());
      // Deterministically place a competing committed write between the
      // operation's read and write. This hook exists only in the local harness.
      let injected = false;
      let queries = 0;
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
        prepare: (sql) => {
          queries += 1;
          if (queries > (input.maxQueries ?? 1000)) {
            throw new Error("Test query budget exhausted.");
          }
          return wrap(sql);
        },
        async batch<T>(statements: D1PreparedStatement[]) {
          const metadata = statements.map((value) => {
            const entry = prepared.get(value);
            if (!entry) {
              throw new Error("Test batch received an unwrapped statement.");
            }
            return entry;
          });
          const writes = metadata.some(({ sql }) =>
            /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)
          );
          if (
            writes &&
            input.beforeWrite &&
            (!injected || input.beforeWrite.repeat)
          ) {
            injected = true;
            await env.DB.prepare(input.beforeWrite.sql)
              .bind(...(input.beforeWrite.values ?? []))
              .all();
          }
          const native = metadata.map((value) => value.native);
          if (writes && input.failReadback) {
            native[native.length - 2] = env.DB.prepare(
              "SELECT abs(-9223372036854775808)"
            );
          }
          return await env.DB.batch<T>(native);
        },
        exec() {
          throw new Error(
            "Test D1 exec bypasses query tracking; use prepared statements."
          );
        },
        dump() {
          throw new Error("Test D1 dump is unsupported.");
        },
        withSession() {
          throw new Error(
            "Test D1 sessions bypass query tracking and are unsupported."
          );
        },
      };
      const now = input.now ?? "2026-08-30T12:00:00Z";
      const services = createServices(db);
      const context = invocationContext({
        env: { DB: db },
        invocation: {
          waitUntil() {
            // The harness answers only after each operation settles.
          },
          passThroughOnException() {
            // No upstream service exists in this harness.
          },
        },
        diagnostic: { id: crypto.randomUUID(), route: "test" },
        clock: fixedClock(now),
      });
      const stores = {
        sessions: services.sessions,
        bodyweight: services.bodyweight,
        bodyfat: services.bodyfat,
        blocks: services.blocks,
        context: services.context,
        schedule: services.schedule,
        plans: services.plans,
        codec: {
          instant,
          chunks(values: unknown[]) {
            const chunks = jsonChunks(values);
            return {
              chunks: chunks.map(({ json, count, offset }) => ({
                count,
                offset,
                bytes: new TextEncoder().encode(json).byteLength,
              })),
              roundTrips:
                JSON.stringify(
                  chunks.flatMap(({ json }) => JSON.parse(json))
                ) === JSON.stringify(values),
            };
          },
          refusal(message: string) {
            const refusal = refusalOf(new Error(message));
            return refusal === undefined
              ? { status: 500 }
              : { status: refusal.status, message: refusal.message };
          },
        },
      };
      const store = Object.entries(stores).find(
        ([name]) => name === input.store
      )?.[1];
      const operation =
        store &&
        Object.entries(store).find(([name]) => name === input.method)?.[1];
      if (!operation) {
        return new Response("Unknown test operation", { status: 400 });
      }
      // oxlint-disable-next-line anti-slop/no-reflect-apply -- Negative persistence tests intentionally pass unvalidated arguments to an own store method.
      const outcome = Reflect.apply(operation, store, input.args);
      return Response.json(
        Effect.isEffect(outcome)
          ? // SAFETY: store operations require nothing beyond the invocation context.
            await run(
              context,
              outcome as Effect.Effect<unknown, unknown, Invocation>
            )
          : await outcome
      );
    } catch (error) {
      // Match the production HTTP boundary when calling services directly.
      const refusal = refusalOf(error);
      // Diagnostic text is allowed only here: the harness holds no real data
      // and has no provider access. Production keeps the safe error envelope.
      return Response.json(
        {
          error:
            refusal?.message ??
            (error instanceof Error ? error.message : "Unknown test failure"),
        },
        { status: refusal?.status ?? 500 }
      );
    }
  },
};
