import { type Database, date, requestId, rows } from "../shared/d1.ts";
import { requireRow } from "../shared/errors.ts";
import type { BlockRow, OpenBlockInput } from "./blocks.types.ts";

const columns = "id, name, goal, started_on, ended_on";

export function blockStore(db: Database) {
  async function listBlocks(): Promise<BlockRow[]> {
    return await rows(db, `SELECT ${columns} FROM blocks ORDER BY started_on`);
  }
  async function replay(uuid: string) {
    return await rows<BlockRow>(
      db,
      `SELECT ${columns} FROM blocks WHERE request_id = ?`,
      uuid,
    );
  }
  async function openBlock(
    b: OpenBlockInput,
  ) {
    const uuid = requestId(b.request_id);
    const [seen] = await replay(uuid);
    if (seen) return { row: seen, created: false };
    const [written] = await rows<BlockRow>(
      db,
      `INSERT INTO blocks (name, goal, started_on, ended_on, request_id)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_id) DO NOTHING RETURNING ${columns}`,
      b.name,
      b.goal,
      date(b.started_on),
      b.ended_on == null ? null : date(b.ended_on),
      uuid,
    );
    return {
      row: written ??
        requireRow(
          await replay(uuid),
          "The block could not be read after saving.",
        ),
      created: written !== undefined,
    };
  }
  return { listBlocks, openBlock };
}
