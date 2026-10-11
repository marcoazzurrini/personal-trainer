import type { Client } from "../../client.ts";
import { targetsRepository } from "./targets.ts";

export function readRepository(client: Client) {
  const targets = targetsRepository(client);
  return { expenditure: targets.expenditure, activeTarget: targets.active };
}
export type ReadRepository = ReturnType<typeof readRepository>;
