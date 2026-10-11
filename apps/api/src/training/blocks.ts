import type { BlocksRepository } from "@trainer/db/repositories/training/blocks.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { requireRow } from "../shared/refusals.ts";
import type { DatabaseFailure, Invalid, NotFound } from "../shared/refusals.ts";
import { date, requestId } from "../shared/values.ts";
import type { BlockRow, OpenBlockInput } from "./blocks.types.ts";

export function blockStore(rows: BlocksRepository) {
  const repository = effectful(rows);

  const listBlocks = Effect.fn("blocks.listBlocks")(
    function* (): Effect.fn.Return<BlockRow[], DatabaseFailure> {
      return yield* repository.list();
    }
  );
  const replay = (uuid: string) => repository.byRequestId(uuid);
  const openBlock = Effect.fn("blocks.openBlock")(function* (
    b: OpenBlockInput
  ): Effect.fn.Return<
    { row: BlockRow; created: boolean },
    Invalid | NotFound | DatabaseFailure
  > {
    const uuid = yield* requestId(b.request_id);
    const [seen] = yield* replay(uuid);
    if (seen) {
      return { row: seen, created: false };
    }
    const [written] = yield* repository.insert({
      name: b.name,
      goal: b.goal,
      started_on: yield* date(b.started_on),
      ended_on:
        b.ended_on === null || b.ended_on === undefined
          ? null
          : yield* date(b.ended_on),
      request_id: uuid,
    });
    return {
      row:
        written ??
        (yield* requireRow(
          yield* replay(uuid),
          "The block could not be read after saving."
        )),
      created: written !== undefined,
    };
  });
  return { listBlocks, openBlock };
}

export type BlockStore = ReturnType<typeof blockStore>;
