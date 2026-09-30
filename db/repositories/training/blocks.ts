import { asc, eq } from "drizzle-orm";

import type { Client } from "../../client.ts";
import type { BlockRecord, NewBlock } from "../../contracts/training.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import { blocks } from "../../schema/index.ts";

const columns = {
  id: blocks.id,
  name: blocks.name,
  goal: blocks.goal,
  started_on: blocks.started_on,
  ended_on: blocks.ended_on,
};

export function blocksRepository(db: Client) {
  async function list(): Promise<BlockRecord[]> {
    try {
      return await db
        .select(columns)
        .from(blocks)
        .orderBy(asc(blocks.started_on));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function byRequestId(uuid: string): Promise<BlockRecord[]> {
    try {
      return await db
        .select(columns)
        .from(blocks)
        .where(eq(blocks.request_id, uuid));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function insert(input: NewBlock): Promise<BlockRecord[]> {
    try {
      return await db
        .insert(blocks)
        .values(input)
        .onConflictDoNothing({ target: blocks.request_id })
        .returning(columns);
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  return { list, byRequestId, insert };
}

export type BlocksRepository = ReturnType<typeof blocksRepository>;
