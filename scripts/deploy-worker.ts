import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "@hono/zod-openapi";

import { buildWorker } from "./build-worker.ts";

const root = nodePath.resolve(import.meta.dirname, "..");
const wrangler = nodePath.resolve(
  root,
  "node_modules/wrangler/bin/wrangler.js"
);

const identity = z.object({
  revision: z.string().nullable(),
  digest: z.string(),
});
const readiness = z.object({
  status: z.literal("ok"),
  build: z.string(),
  revision: z.string().nullable(),
});
interface VerificationOptions {
  fetcher?: (url: URL, init: RequestInit) => Response | Promise<Response>;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
}

export async function verifyRelease(
  url: string,
  expected: z.infer<typeof identity>,
  options: VerificationOptions = {}
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? delay;
  const attempts = options.attempts ?? 60;
  const target = new URL(url);
  if (target.protocol !== "https:") {
    throw new Error("Release verification requires HTTPS.");
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    target.searchParams.set("release_probe", crypto.randomUUID());
    try {
      const response = await fetcher(target, {
        redirect: "error",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(10_000),
      });
      const body = response.ok
        ? readiness.safeParse(await response.json())
        : undefined;
      if (
        body?.success &&
        body.data.build === expected.digest &&
        body.data.revision === expected.revision &&
        response.headers.get("Cache-Control")?.includes("no-store")
      ) {
        return;
      }
    } catch {
      // A refused, timed-out or malformed probe is not evidence of a release.
    }
    if (attempt + 1 < attempts) {
      await sleep(5000);
    }
  }
  throw new Error(
    "The expected Worker build did not become publicly ready. Deployment or migrations may already have changed production; inspect before retrying or rolling back."
  );
}

export async function deployWorker() {
  const metadata = await buildWorker();
  const run = (args: string[]) =>
    execFileSync("node", [wrangler, ...args], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
  // Serialize this entire operation in CI. A Worker rollback does not undo a
  // schema change, and schema changes must support the previously deployed code.
  run(["d1", "migrations", "apply", "personal-trainer", "--remote"]);
  run([
    "deploy",
    "--no-bundle",
    "--message",
    `Source build ${metadata.digest}`,
  ]);
  const built = identity.parse(
    JSON.parse(
      await readFile(nodePath.resolve(root, "dist/build.json"), "utf-8")
    )
  );
  if (
    built.digest !== metadata.digest ||
    built.revision !== metadata.revision
  ) {
    throw new Error(
      "Source changed while deploying. The deployed artifact must be inspected before declaring success."
    );
  }
  const health =
    process.env.DEPLOY_HEALTH_URL ??
    "https://trainer.marcoazzurrini.com/api/health";
  await verifyRelease(health, metadata);
  console.log(
    `Verified Worker build ${metadata.digest} at the public health endpoint.`
  );
}

if (
  process.argv[1] &&
  nodePath.resolve(process.argv[1]) === import.meta.filename
) {
  await deployWorker();
}
