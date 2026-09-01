// What is known about Marco: a topic, a sentence, and when it was written.
//
// Append-only. Correcting or retiring a fact means writing a new row on the
// same topic, so the current picture is the latest row per topic and the
// history is every row in order.
//
// It is not a topic of its own — no commit has ever touched it alone — so it
// lives with its only reader, which is training state (ADR-0006, Fog 3).

import { sql } from "../db.ts";
import { writeOnce } from "../record/idempotency.ts";

export interface ContextEntry {
  id: number;
  topic: string;
  content: string;
  written_at: string;
}

function entryColumns() {
  return sql`id, topic, content, written_at`;
}

/**
 * All current entries together (latest row per topic), never a filtered
 * subset: a coach's picture of a person is coherent.
 *
 * The tie-break is part of the definition. It was written out twice — here and
 * in training state — and a change to it in one was silent in the other.
 */
export async function currentContext(): Promise<ContextEntry[]> {
  return await sql<ContextEntry[]>`
    select distinct on (topic) ${entryColumns()}
    from user_context
    order by topic, written_at desc, id desc`;
}

/** Every row ever written, in order. */
export async function contextHistory(): Promise<ContextEntry[]> {
  return await sql<ContextEntry[]>`
    select ${entryColumns()}
    from user_context
    order by written_at, id`;
}

export async function appendContext(b: {
  topic: string;
  content: string;
  request_id: string;
}): Promise<{ row: ContextEntry; created: boolean }> {
  // Append-only, so nothing else would ever collide: two identical rows on the
  // same topic are indistinguishable from having written the fact twice.
  const { body: row, status } = await writeOnce<
    ContextEntry,
    ContextEntry,
    ContextEntry
  >({
    table: "user_context",
    requestId: b.request_id,
    select: entryColumns(),
    replay: (existing) => existing,
    write: async () => {
      const [written] = await sql<ContextEntry[]>`
        insert into user_context (topic, content, request_id)
        values (${b.topic}, ${b.content}, ${b.request_id})
        returning ${entryColumns()}`;
      return written;
    },
  });
  return { row, created: status === 201 };
}
