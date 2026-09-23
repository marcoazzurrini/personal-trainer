import { nutritionStateStore } from "../../api/nutrition/state.ts";
import { nutritionWeeklyStore } from "../../api/nutrition/weekly.ts";
import type { Database, Statement } from "../../api/shared/d1.ts";

// Synthetic, local-only harness. Count actual statements and bindings so a
// larger requested history cannot silently become a subrequest per week.
export default {
  async fetch(request: Request, env: { DB: Database }): Promise<Response> {
    const input = (await request.json()) as {
      method: "nutritionState" | "finishedWeeks";
      now: string;
      weeks?: number;
      nextNow?: string;
    };
    let queries = 0;
    let maxBindings = 0;
    let clockCalls = 0;
    const wrap = (statement: Statement): Statement => ({
      bind(...values) {
        maxBindings = Math.max(maxBindings, values.length);
        return wrap(statement.bind(...values));
      },
      all<T>() {
        queries++;
        return statement.all<T>();
      },
    });
    const db: Database = {
      prepare: (query) => wrap(env.DB.prepare(query)),
      batch: () => {
        throw new Error("Nutrition summaries must remain read-only.");
      },
    };
    const clock = () =>
      new Date(clockCalls++ > 0 && input.nextNow ? input.nextNow : input.now);
    try {
      const result = input.method === "nutritionState"
        ? await nutritionStateStore(db, clock).nutritionState()
        : await nutritionWeeklyStore(db, clock).finishedWeeks(
          input.weeks ?? 8,
        );
      return Response.json({ result, queries, maxBindings, clockCalls });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
