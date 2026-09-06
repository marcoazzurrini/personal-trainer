// Test-only entrypoint. No identity route or test dependency ships in the image.
import {
  assertIdentity,
  databaseIdentity,
  verifiedDatabase,
} from "./disposable.ts";

const d = await verifiedDatabase();
Deno.env.set("DATABASE_URL", d.databaseUrl);
const { sql } = await import("../api/db.ts");
// Verify the actual operations' singleton before importing/serving the API.
assertIdentity(d, await databaseIdentity(sql));
const { handleRequest } = await import("../api/index.ts");
const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, async (req) => {
  if (new URL(req.url).pathname === "/api/__test_identity") {
    const identity = await databaseIdentity(sql);
    assertIdentity(d, identity);
    return Response.json(identity);
  }
  return handleRequest(req);
});
await Deno.writeTextFile(
  `${Deno.env.get("TEST_DISPOSABLE_FILE")}.ready`,
  `http://127.0.0.1:${server.addr.port}/api`,
);
