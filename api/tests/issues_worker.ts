// An independent API instance, with its own module cache and Postgres pool.
// Only the disposable test receipt may select its database.
import { verifiedDatabase } from "./disposable.ts";
self.onmessage = async (event: MessageEvent) => {
  try {
    const d = await verifiedDatabase();
    Deno.env.set("DATABASE_URL", d.databaseUrl);
    Deno.env.set("GITHUB_API_BASE", event.data.stub);
    Deno.env.set("GITHUB_TOKEN", "synthetic");
    Deno.env.set("GITHUB_REPO", "o/r");
    const { handleRequest } = await import("../index.ts");
    const { sql } = await import("../db.ts");
    const { issueToken } = await import("../access/tokens.ts");
    try {
      const { token } = await issueToken("user_test");
      const response = await handleRequest(
        new Request("http://localhost/api/issues", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(event.data.body),
        }),
      );
      self.postMessage({
        status: response.status,
        body: await response.json(),
      });
    } finally {
      await sql.end();
    }
  } catch {
    self.postMessage({ failed: true });
  }
};
