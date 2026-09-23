import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  COACH_LABEL,
  commentOnIssue,
  GithubError,
  issueBody,
  listCoachIssues,
  openIssue,
} from "../surfaces/github.ts";

// --- The route's validation, through the running function ---------------
// A valid report is never sent here: the local stack has no GITHUB_TOKEN,
// and if one were ever configured the test would file a real issue. So the
// route is exercised up to the point of validation, and everything past it
// is covered against the stub below.

Deno.test("issues endpoint", async (t) => {
  const { api } = await import("./helpers.ts");
  await t.step("is behind the token", async () => {
    const { status } = await api.postRaw("/issues", {}, null);
    assertEquals(status, 401);
  });

  await t.step("requires a request_id", async () => {
    const { status, body } = await api.postRaw("/issues", {
      kind: "bug",
      title: "t",
      problem: "p",
      evidence: "e",
    });
    assertEquals(status, 422);
    assert(body.error.includes("request_id"));
  });

  await t.step("requires a kind, and says what the two mean", async () => {
    for (const kind of [undefined, "question", "docs", 3]) {
      const { status, body } = await api.post("/issues", {
        ...(kind === undefined ? {} : { kind }),
        title: "t",
        problem: "p",
      });
      assertEquals(status, 422, String(kind));
      assert(body.error.includes("bug"), String(kind));
      assert(body.error.includes("improvement"), String(kind));
    }
  });

  await t.step("requires title and problem", async () => {
    let res = await api.post("/issues", { kind: "improvement", problem: "p" });
    assertEquals(res.status, 422);
    assert(res.body.error.includes("title"));

    res = await api.post("/issues", { kind: "improvement", title: "t" });
    assertEquals(res.status, 422);
    assert(res.body.error.includes("problem"));
  });

  // The one asymmetry in the shape, and the reason it exists: a bug is
  // fixed from the repository, and nothing there can reproduce a paraphrase.
  await t.step("a bug requires evidence; an improvement does not", async () => {
    const { status, body } = await api.post("/issues", {
      kind: "bug",
      title: "t",
      problem: "p",
    });
    assertEquals(status, 422);
    assert(body.error.includes("evidence"));
    assert(body.error.includes("improvement"), "it should offer the way out");

    // The same body as an improvement gets past validation and dies at the
    // unconfigured GitHub instead — which is how far this stack can go.
    const improvement = await api.post("/issues", {
      kind: "improvement",
      title: "t",
      problem: "p",
    });
    assertEquals(improvement.status, 500);
    assert(improvement.body.error.includes("GITHUB_TOKEN"));
  });

  await t.step("rejects a docs entry that is not a document name", async () => {
    for (const name of ["../secrets", "Tasks/Logging", "a.md", "/index"]) {
      const { status, body } = await api.post("/issues", {
        kind: "improvement",
        title: "t",
        problem: "p",
        docs: [name],
      });
      assertEquals(status, 422, name);
      assert(body.error.includes("document name"), name);
    }
  });

  await t.step("caps a field that would not be read anyway", async () => {
    const { status, body } = await api.post("/issues", {
      kind: "improvement",
      title: "t",
      problem: "x".repeat(4_001),
    });
    assertEquals(status, 422);
    assert(body.error.includes("problem"));
  });

  await t.step("a comment needs a note", async () => {
    const { status, body } = await api.postRaw("/issues/12/comments", {});
    assertEquals(status, 422);
    assert(body.error.includes("note"));
  });

  await t.step("a comment on a non-numeric issue is rejected", async () => {
    const { status, body } = await api.postRaw("/issues/abc/comments", {
      note: "n",
    });
    assertEquals(status, 422);
    assert(body.error.includes("issue id"));
  });
});

// --- The issue's markdown ------------------------------------------------
// Assembled by the server so every report reads the same way; whoever picks
// it up in the repository should find the evidence in a known place.

Deno.test("issue body", async (t) => {
  const requestId = "11111111-2222-3333-4444-555555555555";

  await t.step("carries every section it was given", () => {
    const body = issueBody({
      problem: "POST /sets 500s.",
      evidence: "Called it on 2026-08-24, got 500.",
      suggestion: "Maybe the check constraint.",
      docs: ["reference/sessions", "tasks/logging"],
      requestId,
    });
    assert(body.includes("POST /sets 500s."));
    assert(body.includes("Called it on 2026-08-24, got 500."));
    assert(body.includes("Maybe the check constraint."));
    assert(body.includes("`reference/sessions`"));
    assert(body.includes("`tasks/logging`"));
    assert(
      body.includes(requestId),
      "the request id correlates the report with its GitHub issue",
    );
  });

  await t.step("omits the headings it has nothing for", () => {
    const body = issueBody({
      problem: "The deload rule reads two ways.",
      evidence: null,
      suggestion: null,
      docs: [],
      requestId,
    });
    assert(!body.includes("What was seen"));
    assert(!body.includes("What the coach suggests"));
    assert(!body.includes("Documents involved"));
    assert(body.includes("The deload rule reads two ways."));
  });

  // The footer is the calibration: first-hand observation, second-hand cause.
  await t.step("says how far to trust it", () => {
    const body = issueBody({
      problem: "p",
      evidence: "e",
      suggestion: null,
      docs: [],
      requestId,
    });
    assert(body.includes("not the repository"));
  });
});

// --- The GitHub client, against a stub server ---------------------------

interface Recorded {
  method: string;
  path: string;
  search: string;
  // deno-lint-ignore no-explicit-any
  body: any;
}

// Plays GitHub: records every request, answers each shape happily.
function stubGithub() {
  const requests: Recorded[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      const url = new URL(req.url);
      const body = req.body ? await req.json() : undefined;
      requests.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        body,
      });

      if (url.pathname.endsWith("/comments") && req.method === "POST") {
        return Response.json({
          html_url: "https://github.com/o/r/issues/7#issuecomment-1",
        }, { status: 201 });
      }
      if (url.pathname.endsWith("/issues") && req.method === "POST") {
        return Response.json(
          { number: 7, html_url: "https://github.com/o/r/issues/7" },
          { status: 201 },
        );
      }
      if (url.pathname.endsWith("/issues") && req.method === "GET") {
        return Response.json([
          {
            number: 7,
            title: "POST /sets 500s",
            html_url: "https://github.com/o/r/issues/7",
            created_at: "2026-08-24T10:00:00Z",
            labels: [{ name: COACH_LABEL }, { name: "bug" }],
          },
          // A pull request. GitHub returns these from the issues endpoint too.
          {
            number: 8,
            title: "Fix the 500",
            html_url: "https://github.com/o/r/pull/8",
            created_at: "2026-08-25T10:00:00Z",
            labels: [{ name: COACH_LABEL }],
            pull_request: { url: "https://api.github.com/repos/o/r/pulls/8" },
          },
        ]);
      }
      return Response.json({}, { status: 201 });
    },
  );
  const cfg = {
    apiBase: `http://127.0.0.1:${server.addr.port}`,
    token: "stub-token",
    repo: "o/r",
  };
  return { cfg, requests, close: () => server.shutdown() };
}

Deno.test("github client", async (t) => {
  await t.step("filing an issue labels it and returns its number", async () => {
    const { cfg, requests, close } = stubGithub();
    try {
      const issue = await openIssue(cfg, {
        title: "POST /sets 500s",
        body: "…",
        kind: "bug",
      });
      assertEquals(issue, {
        number: 7,
        url: "https://github.com/o/r/issues/7",
      });

      const post = requests.find((r) => r.method === "POST")!;
      assertEquals(post.path, "/repos/o/r/issues");
      assertEquals(post.body.title, "POST /sets 500s");
      // Both labels: one says who filed it, one says what it is.
      assertEquals(post.body.labels, [COACH_LABEL, "bug"]);
    } finally {
      await close();
    }
  });

  // The trap the pull-request version of this feature never had to face.
  await t.step("listing drops the pull requests GitHub mixes in", async () => {
    const { cfg, requests, close } = stubGithub();
    try {
      const listed = await listCoachIssues(cfg);
      assertEquals(listed, [{
        number: 7,
        title: "POST /sets 500s",
        url: "https://github.com/o/r/issues/7",
        kind: "bug",
        created_at: "2026-08-24T10:00:00Z",
      }]);

      const get = requests.find((r) => r.method === "GET")!;
      assert(get.search.includes("state=open"));
      assert(get.search.includes(`labels=${COACH_LABEL}`));
    } finally {
      await close();
    }
  });

  await t.step("a comment posts to the issue's thread", async () => {
    const { cfg, requests, close } = stubGithub();
    try {
      const { url } = await commentOnIssue(cfg, 7, "Happened again.");
      assert(url.includes("issuecomment"));
      const post = requests.find((r) => r.path.endsWith("/comments"))!;
      assertEquals(post.path, "/repos/o/r/issues/7/comments");
      assertEquals(post.body.body, "Happened again.");
    } finally {
      await close();
    }
  });

  await t.step(
    "malformed successes never invent a receipt or repeat a write",
    async () => {
      let response = "";
      let calls = 0;
      const server = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
      }, async (req) => {
        await req.text();
        calls++;
        return new Response(response, {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      });
      const cfg = {
        apiBase: `http://127.0.0.1:${server.addr.port}`,
        token: "local-token",
        repo: "o/r",
      };
      try {
        for (
          response of [
            "not json",
            "null",
            "{}",
            "[]",
            '{"html_url":""}',
            '{"number":0,"html_url":"https://github.com/o/r/issues/7"}',
            '{"number":7,"html_url":42}',
            '{"number":7,"html_url":"garbage"}',
            '{"number":7,"html_url":"/relative/path"}',
            '{"number":7,"html_url":"javascript:alert(1)"}',
          ]
        ) {
          const before = calls;
          const error = await assertRejects(
            () => openIssue(cfg, { title: "t", body: "b", kind: "bug" }),
            GithubError,
          );
          assertEquals(error.status, 502);
          assert(error.message.includes("before retrying"), error.message);
          assertEquals(calls, before + 1);
        }
        for (
          response of [
            "not json",
            "null",
            "{}",
            '{"html_url":""}',
            '{"html_url":42}',
            '{"html_url":"garbage"}',
            '{"html_url":"/relative/path"}',
            '{"html_url":"javascript:alert(1)"}',
          ]
        ) {
          const before = calls;
          const error = await assertRejects(
            () => commentOnIssue(cfg, 7, "n"),
            GithubError,
          );
          assertEquals(error.status, 502);
          assert(error.message.includes("before retrying"), error.message);
          assertEquals(calls, before + 1);
        }
        const validIssue = {
          number: 7,
          title: "A report",
          html_url: "https://github.com/o/r/issues/7",
          created_at: "2026-08-24T10:00:00Z",
          labels: [{ name: COACH_LABEL }, { name: "bug" }],
        };
        for (
          response of [
            "not json",
            "null",
            "{}",
            "[{}]",
            ...[
              { labels: null },
              { labels: [null] },
              { labels: [{ name: 7 }] },
              { created_at: "not a timestamp" },
              { html_url: "garbage" },
              { html_url: "/relative/path" },
              { html_url: "javascript:alert(1)" },
            ].map((invalid) => JSON.stringify([{ ...validIssue, ...invalid }])),
          ]
        ) {
          const before = calls;
          const error = await assertRejects(
            () => listCoachIssues(cfg),
            GithubError,
          );
          assertEquals(error.status, 502);
          assertEquals(calls, before + 1);
        }
        response = JSON.stringify([validIssue]);
        assertEquals(await listCoachIssues(cfg), [{
          number: 7,
          title: validIssue.title,
          url: validIssue.html_url,
          kind: "bug",
          created_at: validIssue.created_at,
        }]);
        response = "[]";
        assertEquals(await listCoachIssues(cfg), []);
      } finally {
        await server.shutdown();
      }
    },
  );

  // The route tells a wrong issue number from an unreachable GitHub by this
  // status; without it a typo answers 502 and blames the server.
  await t.step("an error surfaces its status and message", async () => {
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      () => Response.json({ message: "Not Found" }, { status: 404 }),
    );
    const cfg = {
      apiBase: `http://127.0.0.1:${server.addr.port}`,
      token: "bad",
      repo: "o/r",
    };
    try {
      const err = await assertRejects(
        () => commentOnIssue(cfg, 999, "n"),
        GithubError,
        "404",
      );
      assertEquals(err.status, 404);
      assert(err.message.includes("Not Found"));
    } finally {
      await server.shutdown();
    }
  });
});
