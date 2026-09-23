import {
  type Clock,
  type Database,
  instant,
  requestId,
  rows,
  systemClock,
  wireInstant,
} from "../shared/d1.ts";
import { requireRow } from "../shared/errors.ts";
import type { AppendContextInput, ContextEntry } from "./user_context.types.ts";

const columns = "id, topic, content, written_at";
const publicEntry = (row: ContextEntry): ContextEntry => ({
  ...row,
  written_at: wireInstant(row.written_at)!,
});

export function contextStore(db: Database, clock: Clock = systemClock) {
  async function currentContext(): Promise<ContextEntry[]> {
    const found = await rows<ContextEntry>(
      db,
      `SELECT ${columns} FROM (
         SELECT ${columns}, row_number() OVER (PARTITION BY topic ORDER BY written_at DESC, id DESC) AS position
         FROM user_context
       ) WHERE position = 1 ORDER BY topic`,
    );
    return found.map(publicEntry);
  }
  async function contextHistory(): Promise<ContextEntry[]> {
    return (await rows<ContextEntry>(
      db,
      `SELECT ${columns} FROM user_context ORDER BY written_at, id`,
    )).map(publicEntry);
  }
  async function replay(uuid: string) {
    return await rows<ContextEntry>(
      db,
      `SELECT ${columns} FROM user_context WHERE request_id = ?`,
      uuid,
    );
  }
  async function appendContext(
    b: AppendContextInput,
  ) {
    const uuid = requestId(b.request_id);
    const [seen] = await replay(uuid);
    if (seen) return { row: publicEntry(seen), created: false };
    const [written] = await rows<ContextEntry>(
      db,
      `INSERT INTO user_context (topic, content, request_id, written_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(request_id) DO NOTHING RETURNING ${columns}`,
      b.topic,
      b.content,
      uuid,
      instant(clock().toISOString()),
    );
    return {
      row: publicEntry(
        written ??
          requireRow(
            await replay(uuid),
            "The context entry could not be read after saving.",
          ),
      ),
      created: written !== undefined,
    };
  }
  return { currentContext, contextHistory, appendContext };
}
