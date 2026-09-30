import type { ContextRepository } from "../../db/repositories/training/context.ts";
import { requireRow } from "../shared/errors.ts";
import {
  instant,
  requestId,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import type { AppendContextInput, ContextEntry } from "./user_context.types.ts";

const publicEntry = (row: ContextEntry): ContextEntry => ({
  ...row,
  written_at: wireInstant(row.written_at),
});

export function contextStore(
  repository: ContextRepository,
  clock: Clock = systemClock
) {
  async function currentContext(): Promise<ContextEntry[]> {
    return (await repository.current()).map(publicEntry);
  }
  async function contextHistory(): Promise<ContextEntry[]> {
    return (await repository.history()).map(publicEntry);
  }
  async function appendContext(b: AppendContextInput) {
    const uuid = requestId(b.request_id);
    const [seen] = await repository.findRequest(uuid);
    if (seen) {
      return { row: publicEntry(seen), created: false };
    }
    const [written] = await repository.append(
      b.topic,
      b.content,
      uuid,
      instant(clock().toISOString())
    );
    return {
      row: publicEntry(
        written ??
          requireRow(
            await repository.findRequest(uuid),
            "The context entry could not be read after saving."
          )
      ),
      created: written !== undefined,
    };
  }
  return { currentContext, contextHistory, appendContext };
}
