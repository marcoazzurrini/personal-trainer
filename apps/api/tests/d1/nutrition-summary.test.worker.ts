import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import { createClient } from "@trainer/db/client.ts";
import { bodyfatRepository } from "@trainer/db/repositories/bodyfat.ts";
import { bodyweightRepository } from "@trainer/db/repositories/bodyweight.ts";
import { nutritionRepositories } from "@trainer/db/repositories/nutrition/index.ts";

import { bodyfatStore } from "../../src/body/bodyfat.ts";
import { bodyweightStore } from "../../src/body/bodyweight.ts";
import { nutritionStateStore } from "../../src/nutrition/state.ts";
import { nutritionWeeklyStore } from "../../src/nutrition/weekly.ts";
import { summaryInput } from "./test-input.ts";

// Synthetic, local-only harness. Count actual statements and bindings so a
// larger requested history cannot silently become a subrequest per week.
export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const input = summaryInput.parse(await request.json());
    let queries = 0;
    let maxBindings = 0;
    let clockCalls = 0;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key) {
          if (key === "bind") {
            return (...values: Parameters<D1PreparedStatement["bind"]>) => {
              maxBindings = Math.max(maxBindings, values.length);
              return wrap(target.bind(...values));
            };
          }
          if (key === "all") {
            return (...args: Parameters<D1PreparedStatement["all"]>) => {
              queries += 1;
              return target.all(...args);
            };
          }
          if (key === "raw") {
            return (...args: Parameters<D1PreparedStatement["raw"]>) => {
              queries += 1;
              return target.raw(...args);
            };
          }
          if (key === "first") {
            return target.first.bind(target);
          }
          if (key === "run") {
            return target.run.bind(target);
          }
        },
      });
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return (query: string) => wrap(target.prepare(query));
        }
        if (key === "batch") {
          return () => {
            throw new Error("Nutrition summaries must remain read-only.");
          };
        }
        if (key === "exec") {
          return target.exec.bind(target);
        }
        if (key === "dump") {
          return target.dump.bind(target);
        }
        if (key === "withSession") {
          return target.withSession.bind(target);
        }
      },
    });
    const clock = () => {
      const now = clockCalls > 0 && input.nextNow ? input.nextNow : input.now;
      clockCalls += 1;
      return new Date(now);
    };
    const client = createClient(db);
    const repositories = nutritionRepositories(client);
    const bodyweight = bodyweightStore(bodyweightRepository(client), clock);
    const bodyfat = bodyfatStore(bodyfatRepository(client), clock);
    try {
      const result =
        input.method === "nutritionState"
          ? await nutritionStateStore(
              repositories.state,
              bodyweight,
              bodyfat,
              clock
            ).nutritionState()
          : await nutritionWeeklyStore(
              repositories.weekly,
              bodyweight,
              bodyfat,
              clock
            ).finishedWeeks(input.weeks ?? 8);
      return Response.json({ result, queries, maxBindings, clockCalls });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
