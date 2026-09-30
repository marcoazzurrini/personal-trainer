import type { BlocksRepository } from "../../db/repositories/training/blocks.ts";
import { requireRow } from "../shared/errors.ts";
import { date, requestId } from "../shared/values.ts";
import type { BlockRow, OpenBlockInput } from "./blocks.types.ts";

export function blockStore(repository: BlocksRepository) {
  async function listBlocks(): Promise<BlockRow[]> {
    return await repository.list();
  }
  async function replay(uuid: string) {
    return await repository.byRequestId(uuid);
  }
  async function openBlock(b: OpenBlockInput) {
    const uuid = requestId(b.request_id);
    const [seen] = await replay(uuid);
    if (seen) {
      return { row: seen, created: false };
    }
    const [written] = await repository.insert({
      name: b.name,
      goal: b.goal,
      started_on: date(b.started_on),
      ended_on:
        b.ended_on === null || b.ended_on === undefined
          ? null
          : date(b.ended_on),
      request_id: uuid,
    });
    return {
      row:
        written ??
        requireRow(
          await replay(uuid),
          "The block could not be read after saving."
        ),
      created: written !== undefined,
    };
  }
  return { listBlocks, openBlock };
}

export type BlockStore = ReturnType<typeof blockStore>;
