// A block is the coarsest unit of the plan: a name, a goal, and the dates it
// ran between. Mesocycles sit inside one; nothing here knows that.

import { sql } from "../db.ts";
import { writeOnce } from "../shared/idempotency.ts";

export interface BlockRow {
  id: number;
  name: string;
  goal: string;
  started_on: string;
  ended_on: string | null;
}

function blockColumns() {
  return sql`id, name, goal, started_on, ended_on`;
}

/** Every block, oldest first. */
export async function listBlocks(): Promise<BlockRow[]> {
  return await sql<BlockRow[]>`
    select ${blockColumns()} from blocks order by started_on`;
}

export async function openBlock(b: {
  name: string;
  goal: string;
  started_on: string;
  ended_on?: string | null;
  request_id: string;
}): Promise<{ row: BlockRow; created: boolean }> {
  const { body: row, status } = await writeOnce<BlockRow, BlockRow, BlockRow>({
    table: "blocks",
    requestId: b.request_id,
    select: blockColumns(),
    replay: (existing) => existing,
    write: async () => {
      const [written] = await sql<BlockRow[]>`
        insert into blocks (name, goal, started_on, ended_on, request_id)
        values (
          ${b.name},
          ${b.goal},
          ${b.started_on},
          ${b.ended_on ?? null},
          ${b.request_id}
        )
        returning ${blockColumns()}`;
      return written;
    },
  });
  return { row, created: status === 201 };
}
