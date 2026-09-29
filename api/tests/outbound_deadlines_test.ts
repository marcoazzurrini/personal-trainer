import { test } from "node:test";

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
import { assert, assertEquals, assertRejects } from "./assertions.ts";

test("GitHub and Withings bound stalled headers and bodies without leaking credentials", async () => {
  const release: PromiseWithResolvers<void> = Promise.withResolvers();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      await req.body?.cancel();
      if (new URL(req.url).pathname.startsWith("/headers")) {
        await release.promise;
        return Response.json({});
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"unfinished":'));
            // oxlint-disable-next-line promise/prefer-await-to-then -- Stream initialization must return while the response body remains stalled.
            release.promise.then(() => {
              try {
                controller.close();
              } catch {
                /* aborted */
              }
            });
          },
        })
      );
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const credential = "synthetic-private-credential";
  try {
    await Promise.all(
      ["headers", "body"].map(async (mode) => {
        const apiBase = `${base}/${mode}`;
        const gh = { apiBase, repo: "o/r", token: credential };
        const withings = {
          apiBase,
          clientId: "test",
          clientSecret: credential,
        };
        await Promise.all(
          [
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
              "timed out after 5 seconds"
            );
            assert(performance.now() - started < 7000);
            assert(!err.message.includes(credential));
            if (i === 1 || i === 2) {
              assert(err.message.includes("may already exist"));
            }
            if (err instanceof GithubError) {
              assertEquals(err.status, 502);
            }
          })
        );
      })
    );
  } finally {
    release.resolve();
    await server.stop(true);
  }
});
