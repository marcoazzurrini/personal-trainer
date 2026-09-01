import { assert, assertEquals, assertStringIncludes } from "@std/assert";

// The half of /issues that issues_test.ts cannot reach. That file tests the
// GitHub client against a stub and the validation over HTTP; the translation
// between them — GithubError becoming the caller's 404 or a 502, the ledger
// row appearing only after GitHub says yes — runs inside the route, which the
// local stack can only run unconfigured. So the route is mounted in-process
// here, on the same error handler production wires, with GITHUB_API_BASE
// pointed at a stub.

const DB_URL = Deno.env.get("TEST_DATABASE_URL") ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

Deno.test(
  "the issues routes translate GitHub's answers",
  // Shares db.ts's singleton connection; see withings_sync_test.ts.
  { sanitizeResources: false, sanitizeOps: false },
  async (t) => {
    Deno.env.set("DATABASE_URL", DB_URL);
    Deno.env.set("GITHUB_TOKEN", "test-token");
    Deno.env.set("GITHUB_REPO", "marco/test-repo");

    const calls: { method: string; path: string; body: unknown }[] = [];
    let reply: { status: number; body: unknown } = { status: 200, body: {} };
    const stub = Deno.serve({ port: 0, onListen() {} }, async (req) => {
      const url = new URL(req.url);
      calls.push({
        method: req.method,
        path: url.pathname + url.search,
        body: req.body === null ? null : await req.json().catch(() => null),
      });
      return Response.json(reply.body, { status: reply.status });
    });
    Deno.env.set(
      "GITHUB_API_BASE",
      `http://127.0.0.1:${(stub.addr as Deno.NetAddr).port}`,
    );

    const { issues } = await import(
      "../supabase/functions/api/surfaces/issues.routes.ts"
    );
    const { errorResponse } = await import(
      "../supabase/functions/api/http/errors.ts"
    );
    const { Hono } = await import("@hono/hono");
    const { sql } = await import("../supabase/functions/api/db.ts");

    const app = new Hono();
    app.onError(errorResponse);
    app.route("/issues", issues);

    async function req(method: string, path: string, body?: unknown) {
      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const parsed = await res.json();
      if (res.status >= 400) {
        // The envelope contract, checked here because these requests never
        // pass through helpers.ts.
        assertEquals(Object.keys(parsed), ["error"]);
        assertEquals(typeof parsed.error, "string");
      }
      return { status: res.status, body: parsed };
    }

    const requestId = crypto.randomUUID();

    await t.step("the list filters out GitHub's pull requests", async () => {
      reply = {
        status: 200,
        body: [
          {
            number: 7,
            title: "A real report",
            html_url: "https://github.com/x/7",
            created_at: "2026-08-20T10:00:00Z",
            labels: [{ name: "coach" }, { name: "bug" }],
          },
          {
            number: 8,
            title: "A labelled pull request",
            html_url: "https://github.com/x/8",
            created_at: "2026-08-21T10:00:00Z",
            labels: [{ name: "coach" }],
            pull_request: {},
          },
        ],
      };
      const { status, body } = await req("GET", "/issues");
      assertEquals(status, 200);
      assertEquals(body.issues.length, 1);
      assertEquals(body.issues[0], {
        number: 7,
        title: "A real report",
        url: "https://github.com/x/7",
        kind: "bug",
        created_at: "2026-08-20T10:00:00Z",
      });
      assertStringIncludes(calls.at(-1)!.path, "/repos/marco/test-repo/issues");
      assertStringIncludes(calls.at(-1)!.path, "labels=coach");
    });

    await t.step("an outage on the list is a 502, not a 500", async () => {
      reply = { status: 500, body: { message: "boom" } };
      const { status, body } = await req("GET", "/issues");
      assertEquals(status, 502);
      assertStringIncludes(body.error, "GitHub replied 500");
    });

    await t.step(
      "filing writes the ledger row only after GitHub says yes",
      async () => {
        reply = {
          status: 201,
          body: { number: 42, html_url: "https://github.com/x/42" },
        };
        const { status, body } = await req("POST", "/issues", {
          kind: "bug",
          title: "The volume read double-counts",
          problem: "Weekly volume reports twice the sets.",
          evidence: "GET /weekly-volume answered 6 after 3 sets.",
          request_id: requestId,
        });
        assertEquals(status, 201);
        assertEquals(body.issue, {
          number: 42,
          url: "https://github.com/x/42",
          kind: "bug",
          title: "The volume read double-counts",
        });
        const posted = calls.at(-1)!;
        assertEquals(posted.method, "POST");
        const sent = posted.body as { labels: string[]; body: string };
        assertEquals(sent.labels, ["coach", "bug"]);
        assertStringIncludes(sent.body, requestId);
        const [row] = await sql`
        select issue_number from coach_issues where request_id = ${requestId}`;
        assertEquals(row.issue_number, 42);
      },
    );

    await t.step(
      "a retry answers from the ledger without calling GitHub",
      async () => {
        reply = { status: 500, body: { message: "GitHub is down" } };
        const before = calls.length;
        const { status, body } = await req("POST", "/issues", {
          kind: "bug",
          title: "The volume read double-counts",
          problem: "Weekly volume reports twice the sets.",
          evidence: "GET /weekly-volume answered 6 after 3 sets.",
          request_id: requestId,
        });
        assertEquals(status, 200);
        assertEquals(body.issue.number, 42);
        assertEquals(calls.length, before);
      },
    );

    await t.step("a failed filing leaves no ledger row", async () => {
      const failedId = crypto.randomUUID();
      reply = { status: 500, body: { message: "down" } };
      const { status } = await req("POST", "/issues", {
        kind: "improvement",
        title: "A report that never lands",
        problem: "This one fails at GitHub.",
        request_id: failedId,
      });
      assertEquals(status, 502);
      const rows = await sql`
        select 1 from coach_issues where request_id = ${failedId}`;
      assertEquals(rows.length, 0);
    });

    await t.step("a wrong issue number is the caller's 404", async () => {
      reply = { status: 404, body: { message: "Not Found" } };
      const { status, body } = await req("POST", "/issues/999/comments", {
        note: "Seen again today.",
      });
      assertEquals(status, 404);
      assertStringIncludes(body.error, "No issue #999");
    });

    await t.step("an outage on a comment is a 502", async () => {
      reply = { status: 500, body: { message: "boom" } };
      const { status, body } = await req("POST", "/issues/7/comments", {
        note: "Seen again today.",
      });
      assertEquals(status, 502);
      assertStringIncludes(body.error, "GitHub replied 500");
    });

    await t.step("a delivered comment returns its url", async () => {
      reply = { status: 201, body: { html_url: "https://github.com/x/c1" } };
      const { status, body } = await req("POST", "/issues/7/comments", {
        note: "Seen again today.",
      });
      assertEquals(status, 201);
      assertEquals(body.comment, { url: "https://github.com/x/c1" });
      const sent = calls.at(-1)!;
      assertStringIncludes(sent.path, "/issues/7/comments");
      assert((sent.body as { body: string }).body.includes("Seen again"));
    });

    await t.step("cleanup", async () => {
      await sql`delete from coach_issues where request_id = ${requestId}`;
      await stub.shutdown();
    });
  },
);
