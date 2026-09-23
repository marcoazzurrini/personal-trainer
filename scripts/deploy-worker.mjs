import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorker } from "./build-worker.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");

export async function verifyRelease(url, expected, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
        signal: AbortSignal.timeout(10000),
      });
      const body = response.ok ? await response.json() : null;
      if (
        body?.status === "ok" && body.build === expected.digest &&
        body.revision === expected.revision &&
        response.headers.get("Cache-Control")?.includes("no-store")
      ) return;
    } catch {
      // A refused, timed-out or malformed probe is not evidence of a release.
    }
    if (attempt + 1 < attempts) await sleep(5000);
  }
  throw new Error(
    "The expected Worker build did not become publicly ready. Deployment or migrations may already have changed production; inspect before retrying or rolling back.",
  );
}

export async function deployWorker() {
  const metadata = await buildWorker();
  const run = (args) =>
    execFileSync(process.execPath, [wrangler, ...args], {
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
  const built = JSON.parse(
    await readFile(resolve(root, "dist/build.json"), "utf8"),
  );
  if (
    built.digest !== metadata.digest || built.revision !== metadata.revision
  ) {
    throw new Error(
      "Source changed while deploying. The deployed artifact must be inspected before declaring success.",
    );
  }
  const health = process.env.DEPLOY_HEALTH_URL ??
    "https://trainer.marcoazzurrini.com/api/health";
  await verifyRelease(health, metadata);
  console.log(
    `Verified Worker build ${metadata.digest} at the public health endpoint.`,
  );
}

if (
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await deployWorker();
}
