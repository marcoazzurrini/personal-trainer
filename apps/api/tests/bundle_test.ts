import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { assertEquals } from "./assertions.ts";

const api = fileURLToPath(new URL("..", import.meta.url));
const wrangler = fileURLToPath(
  new URL("../../../node_modules/.bin/wrangler", import.meta.url)
);

// What deploys is the bundle Wrangler builds, so that is the one inspected.
// Zod's locale index is aliased away in wrangler.jsonc because nothing here
// selects a locale; without the alias every language rides along, about a
// third of the Worker. English stays: Zod's own defaults import it directly.
test("the Worker bundle carries Zod's English messages and no other locale", async () => {
  const out = await mkdtemp(nodePath.join(tmpdir(), "pt-bundle-"));
  try {
    const metafile = nodePath.join(out, "meta.json");
    await promisify(execFile)(
      wrangler,
      ["deploy", "--dry-run", "--outdir", out, "--metafile", metafile],
      { cwd: api, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }
    );
    const meta: { inputs: Record<string, { bytes: number }> } = JSON.parse(
      await readFile(metafile, "utf-8")
    );
    const locales = Object.keys(meta.inputs)
      .filter((input) => input.includes("zod/v4/locales/"))
      .map((input) => nodePath.basename(input));
    assertEquals(locales, ["en.js"]);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
