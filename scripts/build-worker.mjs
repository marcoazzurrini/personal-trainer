import { build } from "esbuild";
import { createHash } from "node:crypto";
import { sourceRevision } from "./source-revision.mjs";
export { sourceRevision } from "./source-revision.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  };
  const placeholder = "__TRAINER_BUILD_DIGEST_PLACEHOLDER__";
  const unstamped = await build({
    ...options,
    define: {
      __BUILD_METADATA__: JSON.stringify({ revision, digest: placeholder }),
    },
  });
  if (
    Object.keys(unstamped.metafile.inputs).some((name) =>
      /api\/db\.ts$|node_modules\/postgres\//.test(name)
    )
  ) {
    throw new Error(
      "The production Worker must not include the retired PostgreSQL runtime.",
    );
  }
  // Stamp one immutable compiler result, not a second build which could read
  // changed source. Hashing the placeholder form avoids a self-referential hash.
  const source = unstamped.outputFiles[0].text;
  if (source.split(placeholder).length !== 2) {
    throw new Error(
      "The Worker must contain exactly one build digest placeholder.",
    );
  }
  const digest = createHash("sha256").update(source).digest("hex");
  const metadata = { revision, digest };
  if (sourceRevision() !== revision) {
    throw new Error(
      "Source revision changed while building. No artifact was written.",
    );
  }
  await mkdir(resolve(root, "dist"), { recursive: true });
  await writeFile(
    resolve(root, "dist/worker.js"),
    source.replace(placeholder, digest),
  );
  await writeFile(
    resolve(root, "dist/build.json"),
    JSON.stringify(metadata) + "\n",
  );
  return metadata;
}

if (
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const metadata = await buildWorker();
  console.log(
    `Worker built: ${metadata.digest}; commit: ${
      metadata.revision ?? "uncommitted source"
    }.`,
  );
}
