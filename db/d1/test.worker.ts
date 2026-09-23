// Local test harness, not a deployable API. It deliberately bypasses HTTP
// schemas to exercise persistence under workerd, with synthetic records only.
import { sessionStore } from "../../api/training/sessions.ts";
import { bodyweightStore } from "../../api/body/bodyweight.ts";
import { bodyfatStore } from "../../api/body/bodyfat.ts";
import { blockStore } from "../../api/training/blocks.ts";
import { contextStore } from "../../api/training/user_context.ts";
import { scheduleStore } from "../../api/training/week_schedule.ts";
import { mesocycleStore } from "../../api/training/mesocycles.ts";
import { ApiError } from "../../api/shared/errors.ts";
import {
  type Database,
  databaseError,
  instant,
  jsonChunks,
  type Parameter,
  type Statement,
} from "../../api/shared/d1.ts";

export default {
  async fetch(request: Request, env: { DB: Database }): Promise<Response> {
    try {
      const input = await request.json() as {
        store:
          | "sessions"
          | "bodyweight"
          | "bodyfat"
          | "blocks"
          | "context"
          | "schedule"
          | "plans"
          | "codec";
        method: string;
        args: unknown[];
        now?: string;
        beforeWrite?: { sql: string; values?: Parameter[]; repeat?: boolean };
        failReadback?: boolean;
        maxQueries?: number;
      };
      // Deterministically place a competing committed write between the
      // operation's read and write. This hook exists only in the local harness.
      let injected = false;
      let queries = 0;
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
        prepare: (sql) => {
          if (++queries > (input.maxQueries ?? 1000)) {
            throw new Error("Test query budget exhausted.");
          }
          return wrap(sql);
        },
        async batch<T>(statements: Statement[]) {
          const metadata = statements.map((value) => prepared.get(value)!);
          const writes = metadata.some(({ sql }) =>
            /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)
          );
          if (
            writes && input.beforeWrite &&
            (!injected || input.beforeWrite.repeat)
          ) {
            injected = true;
            await env.DB.prepare(input.beforeWrite.sql).bind(
              ...(input.beforeWrite.values ?? []),
            ).all();
          }
          const native = metadata.map((value) => value.native);
          if (writes && input.failReadback) {
            native[native.length - 2] = env.DB.prepare(
              "SELECT abs(-9223372036854775808)",
            );
          }
          return await env.DB.batch<T>(native);
        },
      };
      const clock = () => new Date(input.now ?? "2026-08-30T12:00:00Z");
      const stores = {
        sessions: sessionStore(db, clock),
        bodyweight: bodyweightStore(db, clock),
        bodyfat: bodyfatStore(db, clock),
        blocks: blockStore(db),
        context: contextStore(db, clock),
        schedule: scheduleStore(db, clock),
        plans: mesocycleStore(db, clock),
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
              roundTrips: JSON.stringify(chunks.flatMap(({ json }) =>
                JSON.parse(json)
              )) === JSON.stringify(values),
            };
          },
          refusal(message: string) {
            const error = databaseError(new Error(message));
            return error instanceof ApiError
              ? { status: error.status, message: error.message }
              : { status: 500 };
          },
        },
      };
      const store = stores[input.store] as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      if (!store || !Object.hasOwn(store, input.method)) {
        return new Response("Unknown test operation", { status: 400 });
      }
      return Response.json(await store[input.method](...input.args));
    } catch (error) {
      // Diagnostic text is allowed only here: the harness holds no real data
      // and has no provider access. Production keeps the safe error envelope.
      return Response.json({
        error: error instanceof Error ? error.message : "Unknown test failure",
      }, { status: error instanceof ApiError ? error.status : 500 });
    }
  },
};
