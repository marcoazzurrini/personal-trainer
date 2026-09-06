// An independent API instance, with its own module cache and Postgres pool.
// Only the disposable test receipt may select its database.
import { verifiedDatabase } from "./disposable.ts";
self.onmessage = async (event: MessageEvent) => {
  try {
    const d = await verifiedDatabase();
    Deno.env.set("DATABASE_URL", d.databaseUrl);
    Deno.env.set("API_TOKEN", "issue-worker-test");
    Deno.env.set("GITHUB_API_BASE", event.data.stub);
    Deno.env.set("GITHUB_TOKEN", "synthetic");
    Deno.env.set("GITHUB_REPO", "o/r");
    const { handleRequest } = await import("../api/index.ts");
    const { sql } = await import("../api/db.ts");
    try {
      const response = await handleRequest(
        new Request("http://localhost/api/issues", {
          method: "POST",
          headers: {
            authorization: "Bearer issue-worker-test",
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
