import { test } from "node:test";

import { assertEquals, assertRejects } from "./assertions.ts";
import { management, verifiedDatabase, verifyDatabase } from "./disposable.ts";

test("fixture access refuses inherited URLs and mismatched capabilities", async () => {
  const d = await verifiedDatabase();
  const previous = process.env["TEST_DATABASE_URL"];
  process.env["TEST_DATABASE_URL"] =
    "postgresql://synthetic@127.0.0.1:1/postgres";
  try {
    await assertRejects(
      verifiedDatabase,
      Error,
      "TEST_DATABASE_URL must not be set"
    );
  } finally {
    if (previous === undefined) {
      delete process.env["TEST_DATABASE_URL"];
    } else {
      process.env["TEST_DATABASE_URL"] = previous;
    }
  }
  await assertRejects(
    () => verifyDatabase({ ...d, run: "0".repeat(64) }),
    Error,
    "identity mismatch"
  );
  await assertRejects(
    () => verifyDatabase({ ...d, secret: "0".repeat(64) }),
    Error,
    "capability required"
  );
  const res = await fetch(d.managementUrl, {
    method: "POST",
    body: JSON.stringify({
      action: "batch",
      statements: [{ sql: "DELETE FROM api_tokens" }],
    }),
  });
  assertEquals(res.status, 403);
  await res.body?.cancel();
  assertEquals(
    (
      await management<{
        run: string;
      }>(d, "identity")
    ).run,
    d.run
  );
});
