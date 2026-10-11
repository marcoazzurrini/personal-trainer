import { and, asc, gte, lte } from "drizzle-orm";

import type { Client } from "../../client.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import { rows } from "../../native.ts";
import { nutrition_effective_events } from "../../schema/index.ts";

export interface WeekRecord {
  week_start: string;
  week_end: string;
  days_logged: number;
  days_flagged: number;
  weigh_ins: number;
  mean_kcal: number | null;
  mean_protein_g: number | null;
  protein_days: number;
  protein_entries: number;
  unknown_protein_entries: number;
  kcal_target: number | null;
  protein_g_target: number;
  target_goal: string;
  target_rate_pct_bw_week: number;
  target_effective_from: string;
  target_changed: number;
}

export interface WeekEventRecord {
  day: string;
  kind: string;
  note: string | null;
}

export function weeklyRepository(client: Client) {
  async function finishedWeeks(
    end: string,
    weeks: number
  ): Promise<WeekRecord[]> {
    // One bounded recursive read, even at the public maximum of 104 weeks.
    return await rows<WeekRecord>(
      client,
      `
      WITH RECURSIVE weeks(week_start, week_end, n) AS (
        SELECT date(?, '-6 days'), ?, 1 WHERE ? > 0
        UNION ALL
        SELECT date(week_start, '-7 days'), date(week_end, '-7 days'), n + 1
        FROM weeks WHERE n < ?
      ), intake AS (
        SELECT w.week_start,
          count(CASE WHEN d.entries > 0 THEN 1 END) AS days_logged,
          count(CASE WHEN d.incomplete THEN 1 END) AS days_flagged,
          avg(CASE WHEN NOT d.incomplete THEN d.kcal END) AS mean_kcal,
          avg(CASE WHEN NOT d.incomplete THEN d.protein_g END) AS mean_protein_g,
          count(CASE WHEN NOT d.incomplete THEN d.protein_g END) AS protein_days,
          coalesce(sum(CASE WHEN NOT d.incomplete THEN d.entries END), 0) AS protein_entries,
          coalesce(sum(CASE WHEN NOT d.incomplete THEN d.entries - d.protein_entries END), 0) AS unknown_protein_entries
        FROM weeks w LEFT JOIN daily_intake d
          ON d.day BETWEEN w.week_start AND w.week_end
        GROUP BY w.week_start
      )
      SELECT w.week_start, w.week_end, i.days_logged, i.days_flagged,
        i.mean_kcal, i.mean_protein_g, i.protein_days, i.protein_entries,
        i.unknown_protein_entries,
        (SELECT count(*) FROM daily_bodyweight b
          WHERE b.day BETWEEN w.week_start AND w.week_end) AS weigh_ins,
        t.kcal_target, t.protein_g_target, t.goal AS target_goal,
        t.rate_pct_bw_week / 100.0 AS target_rate_pct_bw_week,
        t.effective_from AS target_effective_from,
        EXISTS (SELECT 1 FROM nutrition_targets t2
          WHERE t2.effective_from > w.week_start
            AND t2.effective_from <= w.week_end) AS target_changed
      FROM weeks w JOIN intake i ON i.week_start = w.week_start
      LEFT JOIN nutrition_targets t ON t.id = (
        SELECT id FROM nutrition_targets
        WHERE effective_from <= w.week_end
        ORDER BY effective_from DESC, id DESC LIMIT 1
      ) ORDER BY w.week_start`,
      end,
      end,
      weeks,
      weeks
    );
  }

  async function events(
    from: string,
    through: string
  ): Promise<WeekEventRecord[]> {
    try {
      // The view compares the entire winning target history before this filter.
      return await client
        .select({
          day: nutrition_effective_events.day,
          kind: nutrition_effective_events.kind,
          note: nutrition_effective_events.note,
        })
        .from(nutrition_effective_events)
        .where(
          and(
            gte(nutrition_effective_events.day, from),
            lte(nutrition_effective_events.day, through)
          )
        )
        .orderBy(
          asc(nutrition_effective_events.day),
          asc(nutrition_effective_events.id)
        );
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  return { finishedWeeks, events };
}

export type WeeklyRepository = ReturnType<typeof weeklyRepository>;
