import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

import type { Client } from "../../client.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import { batch, statement } from "../../native.ts";
import {
  nutrition_effective_events,
  nutrition_events,
} from "../../schema/index.ts";
import {
  canonicalDate,
  canonicalInstant,
  canonicalUuid,
} from "../../storage.ts";

export type EventKind =
  | "creatine_start"
  | "phase_switch"
  | "program_change"
  | "logging_change"
  | "other";

export interface EventRecord {
  id: number;
  day: string;
  kind: EventKind;
  note: string | null;
  created_at: string;
}

export type EventWithdrawal = Pick<EventRecord, "day" | "kind" | "note">;

export interface SaveEventInput {
  day: string;
  kind: EventKind;
  note: string | null;
  request_id: string;
  created_at: string;
}

const event = {
  id: nutrition_events.id,
  day: nutrition_events.day,
  // The table CHECK and the goal-switch view restrict kinds to EventKind.
  kind: sql<EventKind>`${nutrition_events.kind}`,
  note: nutrition_events.note,
  created_at: nutrition_events.created_at,
};
const effectiveEvent = {
  id: nutrition_effective_events.id,
  day: nutrition_effective_events.day,
  kind: sql<EventKind>`${nutrition_effective_events.kind}`,
  note: nutrition_effective_events.note,
};

export function eventsRepository(client: Client) {
  async function list(): Promise<EventRecord[]> {
    try {
      return await client
        .select({
          ...effectiveEvent,
          created_at: nutrition_effective_events.created_at,
        })
        .from(nutrition_effective_events)
        .orderBy(
          desc(nutrition_effective_events.day),
          desc(nutrition_effective_events.id)
        );
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function inRange(
    from: string,
    through: string
  ): Promise<Omit<EventRecord, "created_at">[]> {
    try {
      return await client
        .select(effectiveEvent)
        .from(nutrition_effective_events)
        .where(
          and(
            gte(nutrition_effective_events.day, from),
            lte(nutrition_effective_events.day, through)
          )
        )
        .orderBy(
          desc(nutrition_effective_events.day),
          desc(nutrition_effective_events.id)
        );
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function findRequest(
    requestId: string
  ): Promise<EventRecord | undefined> {
    try {
      const [row] = await client
        .select(event)
        .from(nutrition_events)
        .where(eq(nutrition_events.request_id, requestId));
      return row;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function save(
    input: SaveEventInput
  ): Promise<{ row: EventRecord | undefined; created: boolean }> {
    try {
      const requestId = canonicalUuid(input.request_id);
      // Insertion and replay readback share one D1 transaction.
      const [inserted, selected] = await client.batch([
        client
          .insert(nutrition_events)
          .values({
            ...input,
            day: canonicalDate(input.day),
            request_id: requestId,
            created_at: canonicalInstant(input.created_at),
          })
          .onConflictDoNothing({ target: nutrition_events.request_id })
          .returning({ id: nutrition_events.id }),
        client
          .select(event)
          .from(nutrition_events)
          .where(eq(nutrition_events.request_id, requestId)),
      ]);
      return { row: selected[0], created: inserted.length > 0 };
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function suppressGoalSwitch(
    id: number
  ): Promise<EventWithdrawal | undefined> {
    // Read the derived event before suppressing it, in the same transaction.
    const result = await batch<EventWithdrawal>(client, [
      statement(
        client,
        "SELECT day, kind, note FROM nutrition_goal_switches WHERE id = ?",
        id
      ),
      statement(
        client,
        `UPDATE nutrition_targets SET phase_switch_suppressed = 1 WHERE id = ? AND phase_switch_suppressed = 0
          AND EXISTS (SELECT 1 FROM nutrition_goal_switches WHERE id = ?) RETURNING id`,
        -id,
        id
      ),
    ]);
    return result[1].results.length > 0 ? result[0].results[0] : undefined;
  }

  async function remove(id: number): Promise<EventWithdrawal | undefined> {
    try {
      const [row] = await client
        .delete(nutrition_events)
        .where(eq(nutrition_events.id, id))
        .returning({ day: event.day, kind: event.kind, note: event.note });
      return row;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  return { list, inRange, findRequest, save, suppressGoalSwitch, remove };
}

export type EventsRepository = ReturnType<typeof eventsRepository>;
