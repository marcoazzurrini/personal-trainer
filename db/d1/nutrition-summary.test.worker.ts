import { nutritionStateStore } from "../../api/nutrition/state.ts";
import { nutritionWeeklyStore } from "../../api/nutrition/weekly.ts";
import type { Database, Statement } from "../../api/shared/d1.ts";
import { summaryInput } from "./test-input.ts";

// Synthetic, local-only harness. Count actual statements and bindings so a
// larger requested history cannot silently become a subrequest per week.
export default {
  async fetch(request: Request, env: { DB: Database }): Promise<Response> {
    const input = summaryInput.parse(await request.json());
    let queries = 0;
    let maxBindings = 0;
    let clockCalls = 0;
    const wrap = (statement: Statement): Statement => ({
      bind(...values) {
        maxBindings = Math.max(maxBindings, values.length);
        return wrap(statement.bind(...values));
      },
      all<T>() {
        queries += 1;
        return statement.all<T>();
      },
    });
    const db: Database = {
      prepare: (query) => wrap(env.DB.prepare(query)),
      batch: () => {
        throw new Error("Nutrition summaries must remain read-only.");
      },
    };
    const clock = () => {
      const now = clockCalls > 0 && input.nextNow ? input.nextNow : input.now;
      clockCalls += 1;
      return new Date(now);
    };
    try {
      const result =
        input.method === "nutritionState"
          ? await nutritionStateStore(db, clock).nutritionState()
          : await nutritionWeeklyStore(db, clock).finishedWeeks(
              input.weeks ?? 8
            );
      return Response.json({ result, queries, maxBindings, clockCalls });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
