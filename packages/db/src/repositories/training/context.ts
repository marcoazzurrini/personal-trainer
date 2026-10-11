import { asc, eq } from "drizzle-orm";

import type { Client } from "../../client.ts";
import type { ContextEntry } from "../../contracts/training.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import { rows } from "../../native.ts";
import { user_context } from "../../schema/index.ts";

const columns = {
  id: user_context.id,
  topic: user_context.topic,
  content: user_context.content,
  written_at: user_context.written_at,
};
export function contextRepository(db: Client) {
  async function current(): Promise<ContextEntry[]> {
    return await rows<ContextEntry>(
      db,
      `SELECT id, topic, content, written_at FROM (
      SELECT id, topic, content, written_at, row_number() OVER (PARTITION BY topic ORDER BY written_at DESC, id DESC) AS position
      FROM user_context
    ) WHERE position = 1 ORDER BY topic`
    );
  }
  async function history(): Promise<ContextEntry[]> {
    try {
      return await db
        .select(columns)
        .from(user_context)
        .orderBy(asc(user_context.written_at), asc(user_context.id));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function findRequest(uuid: string): Promise<ContextEntry[]> {
    try {
      return await db
        .select(columns)
        .from(user_context)
        .where(eq(user_context.request_id, uuid));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function append(
    topic: string,
    content: string,
    uuid: string,
    writtenAt: string
  ): Promise<ContextEntry[]> {
    try {
      return await db
        .insert(user_context)
        .values({ topic, content, request_id: uuid, written_at: writtenAt })
        .onConflictDoNothing({ target: user_context.request_id })
        .returning(columns);
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  return { current, history, findRequest, append };
}
export type ContextRepository = ReturnType<typeof contextRepository>;
