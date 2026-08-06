import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { isDocName } from "../supabase/functions/api/lib/doc_names.ts";
import {
  GithubError,
  listDocsProposals,
  openDocsProposal,
} from "../supabase/functions/api/lib/github.ts";
import { api } from "./helpers.ts";

// --- The route's validation, through the running function ---------------
// A valid proposal is never sent here: the local stack has no GITHUB_TOKEN,
// and if one were ever configured the test would open a real PR.

Deno.test("docs proposals endpoint", async (t) => {
  await t.step("is behind the token", async () => {
    const { status } = await api.post("/docs-proposals", {}, null);
    assertEquals(status, 401);
  });

  await t.step("requires title, rationale, and changes", async () => {
    let res = await api.post("/docs-proposals", { rationale: "r" });
    assertEquals(res.status, 422);
    assert(res.body.error.includes("title"));

    res = await api.post("/docs-proposals", { title: "t" });
    assertEquals(res.status, 422);
    assert(res.body.error.includes("rationale"));

    res = await api.post("/docs-proposals", {
      title: "t",
      rationale: "r",
      changes: [],
    });
    assertEquals(res.status, 422);
    assert(res.body.error.includes("changes"));
  });

  await t.step("rejects a path that is not a document name", async () => {
    for (const path of ["../secrets", "Docs/Index", "a.md", "/index"]) {
      const { status, body } = await api.post("/docs-proposals", {
        title: "t",
        rationale: "r",
        changes: [{ path, content: "# X" }],
      });
      assertEquals(status, 422, path);
      assert(body.error.includes("document name"), path);
    }
  });

  await t.step("rejects content together with delete", async () => {
    const { status, body } = await api.post("/docs-proposals", {
      title: "t",
      rationale: "r",
      changes: [{ path: "index", content: "# X", delete: true }],
    });
    assertEquals(status, 422);
    assert(body.error.includes("one or the other"));
  });

  await t.step("rejects the same document twice", async () => {
    const { status, body } = await api.post("/docs-proposals", {
      title: "t",
      rationale: "r",
      changes: [
        { path: "index", content: "# A" },
        { path: "index", content: "# B" },
      ],
    });
    assertEquals(status, 422);
    assert(body.error.includes("twice"));
  });
});

// --- The GitHub client, against a stub server ---------------------------

interface Recorded {
  method: string;
  path: string;
  // deno-lint-ignore no-explicit-any
  body: any;
}

// Plays GitHub: records every request, serves the sha lookup from
// `existing` (repo path -> sha), answers everything else happily.
function stubGithub(existing: Record<string, string> = {}) {
  const requests: Recorded[] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const body = req.body ? await req.json() : undefined;
    requests.push({ method: req.method, path: url.pathname, body });

    if (url.pathname.endsWith("/git/ref/heads/main")) {
      return Response.json({ object: { sha: "main-sha" } });
    }
    if (req.method === "GET" && url.pathname.includes("/contents/")) {
      const repoPath = url.pathname.split("/contents/")[1];
      const sha = existing[repoPath];
      if (!sha) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({ sha });
    }
    if (url.pathname.endsWith("/pulls") && req.method === "POST") {
      return Response.json({ html_url: "https://github.com/o/r/pull/7" }, {
        status: 201,
      });
    }
    if (url.pathname.endsWith("/pulls") && req.method === "GET") {
      return Response.json([
        { title: "Docs: x", html_url: "https://x", head: { ref: "docs/ab" } },
        { title: "Feature", html_url: "https://y", head: { ref: "feat/z" } },
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
  await t.step(
    "creating a doc: branch, sha-less put, pull request",
    async () => {
      const { cfg, requests, close } = stubGithub();
      try {
        const content = "# Strength\n\n3–5 reps × heavy.";
        const { prUrl, branch } = await openDocsProposal(cfg, {
          title: "Add strength method",
          rationale: "The goal changed.",
          changes: [{
            repoPath: "supabase/functions/api/docs/method/strength.md",
            content,
          }],
        });

        assertEquals(prUrl, "https://github.com/o/r/pull/7");
        assertMatch(branch, /^docs\/[0-9a-f]{8}$/);

        const put = requests.find((r) => r.method === "PUT")!;
        assertEquals(put.body.branch, branch);
        assertEquals(put.body.sha, undefined); // new file: no lock to present
        // The content survives base64 intact, unicode included.
        assertEquals(
          new TextDecoder().decode(
            Uint8Array.from(atob(put.body.content), (ch) => ch.charCodeAt(0)),
          ),
          content,
        );

        const pr = requests.find((r) => r.path.endsWith("/pulls"))!;
        assertEquals(pr.body.head, branch);
        assertEquals(pr.body.base, "main");
        assert(pr.body.body.includes("The goal changed."));
      } finally {
        await close();
      }
    },
  );

  await t.step("updating and deleting present the file's sha", async () => {
    const { cfg, requests, close } = stubGithub({
      "supabase/functions/api/docs/programming.md": "sha-p",
      "supabase/functions/api/docs/charts.md": "sha-c",
    });
    try {
      await openDocsProposal(cfg, {
        title: "t",
        rationale: "r",
        changes: [
          {
            repoPath: "supabase/functions/api/docs/programming.md",
            content: "# P",
          },
          { repoPath: "supabase/functions/api/docs/charts.md", content: null },
        ],
      });
      const put = requests.find((r) => r.method === "PUT")!;
      assertEquals(put.body.sha, "sha-p");
      const del = requests.find((r) => r.method === "DELETE")!;
      assertEquals(del.body.sha, "sha-c");
    } finally {
      await close();
    }
  });

  await t.step("deleting a doc that does not exist fails", async () => {
    const { cfg, close } = stubGithub();
    try {
      await assertRejects(
        () =>
          openDocsProposal(cfg, {
            title: "t",
            rationale: "r",
            changes: [{
              repoPath: "supabase/functions/api/docs/nope.md",
              content: null,
            }],
          }),
        GithubError,
        "no such file",
      );
    } finally {
      await close();
    }
  });

  await t.step("a GitHub error surfaces status and message", async () => {
    const server = Deno.serve(
      { port: 0, onListen() {} },
      () => Response.json({ message: "Bad credentials" }, { status: 401 }),
    );
    try {
      await assertRejects(
        () =>
          openDocsProposal(
            {
              apiBase: `http://127.0.0.1:${server.addr.port}`,
              token: "bad",
              repo: "o/r",
            },
            { title: "t", rationale: "r", changes: [] },
          ),
        GithubError,
        "401",
      );
    } finally {
      await server.shutdown();
    }
  });

  await t.step("listing keeps only docs/ branches", async () => {
    const { cfg, close } = stubGithub();
    try {
      const proposals = await listDocsProposals(cfg);
      assertEquals(proposals, [
        { title: "Docs: x", url: "https://x", branch: "docs/ab" },
      ]);
    } finally {
      await close();
    }
  });
});

Deno.test("document names", () => {
  for (const good of ["index", "method/hypertrophy", "a-b/c-d/e2"]) {
    assert(isDocName(good), good);
  }
  for (
    const bad of ["", "..", "a..b", "a.md", "/a", "a/", "A", "a b", "a//b"]
  ) {
    assert(!isDocName(bad), bad);
  }
  assert(!isDocName("x".repeat(81)), "over the length cap");
});
