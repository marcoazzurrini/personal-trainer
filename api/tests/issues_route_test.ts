import { assert, assertEquals, assertStringIncludes } from "@std/assert";

// Mount only the issue routes with production's error handler. Authentication
// remains covered by the running API tests. Denying DATABASE_URL access makes
// importing db.ts fail, and network access is restricted to local GitHub stubs.
// No disposable database or resource-sanitizer exception is needed.

Deno.test(
  "the issues routes relay GitHub's answers without database access",
  {
    permissions: {
      env: ["GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_API_BASE"],
      net: ["127.0.0.1", "0.0.0.0"],
    },
  },
  async (t) => {
    const previous = new Map(
      ["GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_API_BASE"].map((key) => [
        key,
        Deno.env.get(key),
      ]),
    );
    Deno.env.set("GITHUB_TOKEN", "test-token");
    Deno.env.set("GITHUB_REPO", "marco/test-repo");

    const calls: {
      method: string;
      path: string;
      body: unknown;
      authorization: string | null;
    }[] = [];
    let reply: { status: number; body: unknown } = { status: 200, body: {} };
    const stub = Deno.serve({ port: 0, onListen() {} }, async (req) => {
      const url = new URL(req.url);
      calls.push({
        method: req.method,
        path: url.pathname + url.search,
        body: req.body === null ? null : await req.json().catch(() => null),
        authorization: req.headers.get("authorization"),
      });
      return Response.json(reply.body, { status: reply.status });
    });
    Deno.env.set(
      "GITHUB_API_BASE",
      `http://127.0.0.1:${(stub.addr as Deno.NetAddr).port}`,
    );

    try {
      const { issues } = await import(
        "../surfaces/issues.routes.ts"
      );
      const { errorResponse } = await import(
        "../shared/errors.ts"
      );
      const { Hono } = await import("@hono/hono");

      const app = new Hono();
      app.onError(errorResponse);
      app.route("/issues", issues);

      const req = async (method: string, path: string, body?: unknown) => {
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
      };

      await t.step("database configuration is not granted", async () => {
        assert(
          (await Deno.permissions.query({
            name: "env",
            variable: "DATABASE_URL",
          })).state !== "granted",
        );
      });

      await t.step(
        "OpenAPI promises correlation, not a replay response",
        () => {
          const document = issues.getOpenAPI31Document({
            openapi: "3.1.0",
            info: { title: "Issue relay", version: "test" },
          });
          const creation = document.paths!["/"]!.post!;
          assertEquals(Object.keys(creation.responses!), ["201", "422", "502"]);
          assertStringIncludes(creation.description!, "correlation marker");
          assertStringIncludes(creation.description!, "may create duplicates");
          assertStringIncludes(creation.description!, "Reconcile in GitHub");
        },
      );

      await t.step(
        "missing GitHub configuration fails before any outbound call",
        async () => {
          for (const key of ["GITHUB_TOKEN", "GITHUB_REPO"]) {
            const value = Deno.env.get(key)!;
            Deno.env.delete(key);
            try {
              const before = calls.length;
              for (
                const [method, path, payload] of [
                  ["GET", "/issues", undefined],
                  ["POST", "/issues", {
                    kind: "improvement",
                    title: "Synthetic report",
                    problem: "Synthetic example",
                    request_id: crypto.randomUUID(),
                  }],
                  ["POST", "/issues/7/comments", { note: "Synthetic note" }],
                ] as const
              ) {
                const { status, body } = await req(method, path, payload);
                assertEquals(status, 500);
                assertEquals(
                  body.error,
                  "Filing issues needs GITHUB_TOKEN and GITHUB_REPO configured on the server.",
                );
              }
              assertEquals(calls.length, before);
            } finally {
              Deno.env.set(key, value);
            }
          }
        },
      );

      await t.step(
        "report validation needs no database or outbound call",
        async () => {
          for (
            const invalid of [
              { kind: "bug", evidence: null },
              { title: "x".repeat(201) },
              { problem: "x".repeat(4_001) },
              { evidence: "x".repeat(8_001) },
              { suggestion: "x".repeat(4_001) },
              { docs: ["../secrets"] },
              { docs: Array(11).fill("tasks/logging") },
            ]
          ) {
            const before = calls.length;
            const { status } = await req("POST", "/issues", {
              kind: "improvement",
              title: "Synthetic report",
              problem: "Synthetic example",
              request_id: crypto.randomUUID(),
              ...invalid,
            });
            assertEquals(status, 422);
            assertEquals(calls.length, before);
          }
          const before = calls.length;
          assertEquals(
            (await req("POST", "/issues/7/comments", {
              note: "x".repeat(8_001),
            })).status,
            422,
          );
          assertEquals(calls.length, before);
        },
      );

      await t.step(
        "public report fields refuse credentials before outbound calls without echo",
        async () => {
          const logged: unknown[][] = [];
          const originalError = console.error;
          console.error = (...args: unknown[]) => {
            logged.push(args);
          };
          try {
            const secret = "synthetic-secret-42";
            for (
              const material of [
                `Authorization: Bearer ${secret}`,
                `bEaReR ${secret}`,
                `Cookie: session=${secret}`,
                `Set-Cookie: session=${secret}; HttpOnly`,
                `{"Cookie":"session=${secret}"}`,
                `curl --cookie 'session=${secret}'`,
                `curl -b 'session=${secret}'`,
                `curl -b'session=${secret}' https://example.invalid`,
                `curl -b"session=${secret}" https://example.invalid`,
                `curl -bsession=${secret} https://example.invalid`,
                `curl -b'[REDACTED]; session=${secret}'`,
                `curl -b"[REDACTED]; session=${secret}"`,
                `curl -b[REDACTED]${secret}`,
                `Bearer [REDACTED]${secret}`,
                `Cookie: [REDACTED]; session=${secret}`,
                `curl --cookie '[REDACTED]; session=${secret}'`,
              ]
            ) {
              for (
                const field of [
                  "title",
                  "problem",
                  "evidence",
                  "suggestion",
                  "docs",
                ]
              ) {
                const before = calls.length;
                const id = crypto.randomUUID();
                const { status, body } = await req("POST", "/issues", {
                  kind: "bug",
                  title: "Synthetic report",
                  problem: "Synthetic example",
                  evidence: "GET /intake returned 500",
                  request_id: id,
                  [field]: field === "docs" ? [material] : material,
                });
                assertEquals(status, 422);
                assertStringIncludes(body.error, "sanitized");
                assert(!JSON.stringify(body).includes(secret));
                assertEquals(calls.length, before);
              }
              const before = calls.length;
              const { status, body } = await req("POST", "/issues/7/comments", {
                note: material,
              });
              assertEquals(status, 422);
              assert(!JSON.stringify(body).includes(secret));
              assertEquals(calls.length, before);
            }
            assertEquals(logged, []);
          } finally {
            console.error = originalError;
          }
        },
      );

      await t.step(
        "redacted and benign public examples still publish",
        async () => {
          reply = {
            status: 201,
            body: { number: 420, html_url: "https://github.com/x/420" },
          };
          const id = crypto.randomUUID();
          const evidence =
            'curl -H "Authorization: Bearer [REDACTED]" -H "Cookie: [REDACTED]" /intake; synthetic response 500\n' +
            "curl -b'[REDACTED]' https://example.invalid\n" +
            'curl -b"[REDACTED]" https://example.invalid\n' +
            "curl https://example.invalid -b[REDACTED]";
          const { status } = await req("POST", "/issues", {
            kind: "bug",
            title: "Synthetic example",
            problem: "const count = 1;",
            evidence,
            request_id: id,
          });
          assertEquals(status, 201);
          assertStringIncludes(
            (calls.at(-1)!.body as { body: string }).body,
            evidence,
          );
          reply = {
            status: 201,
            body: { html_url: "https://github.com/x/c42" },
          };
          assertEquals(
            (await req("POST", "/issues/420/comments", { note: evidence }))
              .status,
            201,
          );
        },
      );

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
        assertStringIncludes(
          calls.at(-1)!.path,
          "/repos/marco/test-repo/issues",
        );
        assertStringIncludes(calls.at(-1)!.path, "labels=coach");
      });

      await t.step("an outage on the list is a 502, not a 500", async () => {
        reply = { status: 500, body: { message: "boom" } };
        const { status, body } = await req("GET", "/issues");
        assertEquals(status, 502);
        assertStringIncludes(body.error, "GitHub replied 500");
      });

      await t.step(
        "filing returns the GitHub result and correlation marker",
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
          assertEquals(posted.authorization, "Bearer test-token");
          const sent = posted.body as { labels: string[]; body: string };
          assertEquals(sent.labels, ["coach", "bug"]);
          assertStringIncludes(sent.body, requestId);
        },
      );

      await t.step(
        "repeating a request_id calls GitHub again and may create another issue",
        async () => {
          reply = {
            status: 201,
            body: { number: 43, html_url: "https://github.com/x/43" },
          };
          const before = calls.length;
          const { status, body } = await req("POST", "/issues", {
            kind: "bug",
            title: "The volume read double-counts",
            problem: "Weekly volume reports twice the sets.",
            evidence: "GET /weekly-volume answered 6 after 3 sets.",
            request_id: requestId,
          });
          assertEquals(status, 201);
          assertEquals(body.issue.number, 43);
          assertEquals(calls.length, before + 1);
        },
      );

      await t.step(
        "a GitHub failure is a 502 without an automatic retry",
        async () => {
          const failedId = crypto.randomUUID();
          reply = { status: 500, body: { message: "down" } };
          const before = calls.length;
          const { status, body } = await req("POST", "/issues", {
            kind: "improvement",
            title: "A report that never lands",
            problem: "This one fails at GitHub.",
            request_id: failedId,
          });
          assertEquals(status, 502);
          assertStringIncludes(body.error, "GitHub replied 500");
          assertEquals(calls.length, before + 1);
        },
      );

      await t.step(
        "unusable GitHub successes return 502, never a fabricated result or retry",
        async () => {
          for (const path of ["/issues", "/issues/7/comments"]) {
            for (
              const malformed of [null, {}, { number: 0, html_url: "invalid" }]
            ) {
              reply = { status: 201, body: malformed };
              const before = calls.length;
              const { status, body } = await req(
                "POST",
                path,
                path === "/issues"
                  ? {
                    kind: "improvement",
                    title: "Synthetic report",
                    problem: "Synthetic example",
                    request_id: crypto.randomUUID(),
                  }
                  : { note: "Synthetic note" },
              );
              assertEquals(status, 502);
              assertStringIncludes(
                body.error,
                "The write may already exist at GitHub",
              );
              assertStringIncludes(body.error, "before retrying");
              assertEquals(calls.length, before + 1);
            }
          }
        },
      );

      await t.step(
        "a lost response after GitHub accepts a write remains uncertain without retry",
        async () => {
          const originalFetch = globalThis.fetch;
          globalThis.fetch = async (...args) => {
            const response = await originalFetch(...args);
            await response.text();
            throw new TypeError("Synthetic connection lost after acceptance");
          };
          try {
            reply = {
              status: 201,
              body: { number: 99, html_url: "https://github.com/x/99" },
            };
            for (const path of ["/issues", "/issues/7/comments"]) {
              const before = calls.length;
              const { status, body } = await req(
                "POST",
                path,
                path === "/issues"
                  ? {
                    kind: "improvement",
                    title: "Synthetic report",
                    problem: "Synthetic example",
                    request_id: crypto.randomUUID(),
                  }
                  : { note: "Synthetic note" },
              );
              assertEquals(status, 502);
              assertStringIncludes(
                body.error,
                "The write may already exist at GitHub",
              );
              assertStringIncludes(
                body.error,
                "do not blindly repeat the write",
              );
              assertEquals(calls.length, before + 1);
            }
          } finally {
            globalThis.fetch = originalFetch;
          }
        },
      );

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
    } finally {
      await stub.shutdown();
      for (const [key, value] of previous) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  },
);
