import { expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }))).flat();
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
    if (!/\.tsx?$/.test(file) || file.endsWith("routeTree.gen.ts")) continue;
    const source = await readFile(file, "utf8");
    expect(source, file).not.toMatch(
      /DATABASE_URL|localStorage|indexedDB|serviceWorker/,
    );
    for (
      const [, specifier] of source.matchAll(
        /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g,
      )
    ) {
      if (specifier.startsWith(".")) {
        expect(
          resolve(dirname(file), specifier).startsWith(root + sep),
          `${file}: ${specifier}`,
        ).toBe(true);
      } else {
        expect(
          allowed.some((prefix) =>
            specifier === prefix ||
            specifier.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")
          ),
          `${file}: ${specifier}`,
        ).toBe(true);
      }
    }
  }
});
