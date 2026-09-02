import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import {
  COACH_LABEL,
  commentOnIssue,
  GithubError,
  issueBody,
  listCoachIssues,
  openIssue,
} from "../api/surfaces/github.ts";
import { api, uuid } from "./helpers.ts";

// --- The route's validation, through the running function ---------------
// A valid report is never sent here: the local stack has no GITHUB_TOKEN,
// and if one were ever configured the test would file a real issue. So the
// route is exercised up to the point of validation, and everything past it
// is covered against the stub below.

Deno.test("issues endpoint", async (t) => {
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
    assert(body.includes(requestId), "the request id is the retry's receipt");
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
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
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
  });
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

  // The route tells a wrong issue number from an unreachable GitHub by this
  // status; without it a typo answers 502 and blames the server.
  await t.step("an error surfaces its status and message", async () => {
    const server = Deno.serve(
      { port: 0, onListen() {} },
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

// --- The retry guarantee's foundation ------------------------------------
// The route's own retry path cannot run here for the same reason a valid
// report cannot: no GITHUB_TOKEN, and configuring one would file real
// issues. What is checkable locally is the thing the guarantee rests on —
// that the ledger physically cannot hold one request_id twice. Without the
// constraint the route's `on conflict do nothing` is a no-op and two racing
// retries each record an issue.

Deno.test("one request_id can only file one issue", async () => {
  const db = postgres(
    Deno.env.get("TEST_DATABASE_URL") ??
      "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
  );
  const requestId = uuid();
  try {
    const insert = (url: string) =>
      db`insert into coach_issues (request_id, issue_number, url, kind, title)
         values (${requestId}, 7, ${url}, 'bug', 't')`;
    await insert("https://github.com/o/r/issues/7");

    let conflicted = false;
    try {
      await insert("https://github.com/o/r/issues/8");
    } catch (err) {
      conflicted = (err as { code?: string }).code === "23505";
    }
    assert(conflicted, "a second row on the same request_id must be refused");

    const [row] = await db`
      select url from coach_issues where request_id = ${requestId}`;
    assertEquals(row.url, "https://github.com/o/r/issues/7");
  } finally {
    await db`delete from coach_issues where request_id = ${requestId}`;
    await db.end();
  }
});
