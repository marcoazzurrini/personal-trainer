import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import type { BuildOptions } from "esbuild";
import { build } from "esbuild";

import { sourceRevision } from "./source-revision.ts";

export { sourceRevision } from "./source-revision.ts";

const root = nodePath.resolve(import.meta.dirname, "..");

export async function buildWorker() {
  const revision = sourceRevision();
  const options = {
    absWorkingDir: root,
    entryPoints: ["api/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
    legalComments: "none",
  } satisfies BuildOptions;
  const placeholder = "__TRAINER_BUILD_DIGEST_PLACEHOLDER__";
  const unstamped = await build({
    ...options,
    define: {
      __BUILD_METADATA__: JSON.stringify({ revision, digest: placeholder }),
    },
  });
  if (
    Object.keys(unstamped.metafile.inputs).some((name) =>
      /api\/db\.ts$|node_modules\/postgres\//u.test(name)
    )
  ) {
    throw new Error(
      "The production Worker must not include the retired PostgreSQL runtime."
    );
  }
  // Stamp one immutable compiler result, not a second build which could read
  // changed source. Hashing the placeholder form avoids a self-referential hash.
  const source = unstamped.outputFiles[0].text;
  if (source.split(placeholder).length !== 2) {
    throw new Error(
      "The Worker must contain exactly one build digest placeholder."
    );
  }
  const digest = createHash("sha256").update(source).digest("hex");
  const metadata = { revision, digest };
  if (sourceRevision() !== revision) {
    throw new Error(
      "Source revision changed while building. No artifact was written."
    );
  }
  await mkdir(nodePath.resolve(root, "dist"), { recursive: true });
  await writeFile(
    nodePath.resolve(root, "dist/worker.js"),
    source.replace(placeholder, digest)
  );
  await writeFile(
    nodePath.resolve(root, "dist/build.json"),
    `${JSON.stringify(metadata)}\n`
  );
  return metadata;
}

if (
  process.argv[1] &&
  nodePath.resolve(process.argv[1]) === import.meta.filename
) {
  const metadata = await buildWorker();
  console.log(
    `Worker built: ${metadata.digest}; commit: ${
      metadata.revision ?? "uncommitted source"
    }.`
  );
}
