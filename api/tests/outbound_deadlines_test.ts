import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  getWeights,
  refreshTokens,
  WithingsError,
} from "../body/withings_client.ts";
import {
  commentOnIssue,
  GithubError,
  listCoachIssues,
  openIssue,
} from "../surfaces/github.ts";

Deno.test("GitHub and Withings bound stalled headers and bodies without leaking credentials", async () => {
  const release = Promise.withResolvers<void>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      await req.body?.cancel();
      if (new URL(req.url).pathname.startsWith("/headers")) {
        await release.promise;
        return Response.json({});
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"unfinished":'));
            release.promise.then(() => {
              try {
                controller.close();
              } catch { /* aborted */ }
            });
          },
        }),
      );
    },
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  const credential = "synthetic-private-credential";
  try {
    await Promise.all(["headers", "body"].map(async (mode) => {
      const apiBase = `${base}/${mode}`;
      const gh = { apiBase, repo: "o/r", token: credential };
      const withings = { apiBase, clientId: "test", clientSecret: credential };
      await Promise.all([
        () => listCoachIssues(gh),
        () => openIssue(gh, { title: "t", body: "p", kind: "bug" }),
        () => commentOnIssue(gh, 1, "note"),
        () => getWeights(withings, credential, { lastupdate: 0 }),
        () => refreshTokens(withings, credential),
      ].map(async (call, i) => {
        const started = performance.now();
        const err = await assertRejects(
          call,
          i < 3 ? GithubError : WithingsError,
          "timed out after 5 seconds",
        );
        assert(performance.now() - started < 7000);
        assert(!err.message.includes(credential));
        if (i === 1 || i === 2) {
          assert(err.message.includes("may already exist"));
        }
        if (err instanceof GithubError) assertEquals(err.status, 502);
      }));
    }));
  } finally {
    release.resolve();
    await server.shutdown();
  }
});
