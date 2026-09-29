import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, it } from "vitest";

const { dirname, resolve, sep } = path;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const file = resolve(directory, entry.name);
        return entry.isDirectory() ? files(file) : [file];
      })
    )
  ).flat();
}

it("the web source can reach neither API implementation nor a database driver", async () => {
  const root = resolve("src");
  const allowed = [
    "@tanstack/",
    "@workos/authkit-tanstack-react-start",
    "react",
    "zod",
  ];
  for (const file of await files(root)) {
    if (!/\.tsx?$/u.test(file) || file.endsWith("routeTree.gen.ts")) {
      continue;
    }
    const source = await readFile(file, "utf-8");
    expect(source, file).not.toMatch(
      /DATABASE_URL|localStorage|indexedDB|serviceWorker/u
    );
    for (const [, specifier] of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](?<specifier>[^"']+)["']/gu
    )) {
      if (specifier.startsWith(".")) {
        expect(
          resolve(dirname(file), specifier).startsWith(root + sep),
          `${file}: ${specifier}`
        ).toBe(true);
      } else {
        // Worker source has no filesystem or database import exception.
        expect(
          allowed.some(
            (prefix) =>
              specifier === prefix ||
              specifier.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
          ),
          `${file}: ${specifier}`
        ).toBe(true);
      }
    }
  }
});
