import { assertRejects } from "@std/assert";
import { verifiedDatabase, verifyDatabase } from "./disposable.ts";

Deno.test("the network database must match the owned cluster receipt before setup", async () => {
  const d = await verifiedDatabase();
  const previous = Deno.env.get("TEST_DATABASE_URL");
  Deno.env.set(
    "TEST_DATABASE_URL",
    "postgresql://synthetic@127.0.0.1:1/postgres",
  );
  try {
    await assertRejects(
      () => verifiedDatabase(),
      Error,
      "TEST_DATABASE_URL does not match the receipt",
    );
  } finally {
    if (previous === undefined) Deno.env.delete("TEST_DATABASE_URL");
    else Deno.env.set("TEST_DATABASE_URL", previous);
  }
  // Only the newly owned disposable database is contacted, by read-only probes.
  await assertRejects(
    () =>
      verifyDatabase({ ...d, systemId: "0000000000000000000" }, d.databaseUrl),
    Error,
    "identity does not match",
  );
  await assertRejects(
    () => verifyDatabase({ ...d, database: "another_database" }, d.databaseUrl),
    Error,
    "identity does not match",
  );
});
