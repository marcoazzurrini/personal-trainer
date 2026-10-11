import type { ContextRepository } from "@trainer/db/repositories/training/context.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { requireRow } from "../shared/refusals.ts";
import type { DatabaseFailure, Invalid, NotFound } from "../shared/refusals.ts";
import { now, requestId, wireInstant } from "../shared/values.ts";
import type { AppendContextInput, ContextEntry } from "./user_context.types.ts";

const publicEntry = (row: ContextEntry): ContextEntry => ({
  ...row,
  written_at: wireInstant(row.written_at),
});

export function contextStore(rows: ContextRepository) {
  const repository = effectful(rows);

  const currentContext = Effect.fn("userContext.currentContext")(
    function* (): Effect.fn.Return<ContextEntry[], DatabaseFailure> {
      return (yield* repository.current()).map(publicEntry);
    }
  );
  const contextHistory = Effect.fn("userContext.contextHistory")(
    function* (): Effect.fn.Return<ContextEntry[], DatabaseFailure> {
      return (yield* repository.history()).map(publicEntry);
    }
  );
  const appendContext = Effect.fn("userContext.appendContext")(function* (
    b: AppendContextInput
  ): Effect.fn.Return<
    { row: ContextEntry; created: boolean },
    Invalid | NotFound | DatabaseFailure
  > {
    const uuid = yield* requestId(b.request_id);
    const [seen] = yield* repository.findRequest(uuid);
    if (seen) {
      return { row: publicEntry(seen), created: false };
    }
    const [written] = yield* repository.append(
      b.topic,
      b.content,
      uuid,
      yield* now
    );
    return {
      row: publicEntry(
        written ??
          (yield* requireRow(
            yield* repository.findRequest(uuid),
            "The context entry could not be read after saving."
          ))
      ),
      created: written !== undefined,
    };
  });
  return { currentContext, contextHistory, appendContext };
}
