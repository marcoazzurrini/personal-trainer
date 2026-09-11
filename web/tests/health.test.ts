import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthResponse, readBuildRevision } from "../src/health.server.ts";

const directories: string[] = [];
function file(value?: string) {
  const directory = mkdtempSync(join(tmpdir(), "trainer-revision-"));
  directories.push(directory);
  const path = join(directory, "revision.txt");
  if (value !== undefined) writeFileSync(path, value);
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("dashboard build revision", () => {
  it("reads a full revision from the image file, not a runtime override", () => {
    const prior = process.env.SOURCE_COMMIT;
    process.env.SOURCE_COMMIT = "b".repeat(40);
    try {
      expect(readBuildRevision(file("a".repeat(40) + "\n"))).toBe(
        "a".repeat(40),
      );
    } finally {
      if (prior === undefined) delete process.env.SOURCE_COMMIT;
      else process.env.SOURCE_COMMIT = prior;
    }
  });

  it("does not invent a revision for a native build", () => {
    expect(readBuildRevision(file())).toBeNull();
  });

  it.each(["", "HEAD", "a".repeat(7), "A".repeat(40), "a".repeat(41)])(
    "refuses malformed metadata %j",
    (value) => expect(() => readBuildRevision(file(value))).toThrow("invalid"),
  );
});

describe("dashboard health", () => {
  it("returns only uncached build metadata", async () => {
    const response = healthResponse(
      new Request("https://dashboard.example.test/api/health"),
      () => "a".repeat(40),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      status: "ok",
      revision: "a".repeat(40),
    });
  });

  it("supports HEAD without a response body", async () => {
    const response = healthResponse(
      new Request("https://dashboard.example.test/api/health", {
        method: "HEAD",
      }),
      () => null,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("refuses other methods without reading metadata", () => {
    const response = healthResponse(
      new Request("https://dashboard.example.test/api/health", {
        method: "POST",
      }),
      () => {
        throw new Error("Must not run");
      },
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it.each(["GET", "HEAD"])(
    "fails closed without leaking file errors for %s",
    async (method) => {
      const response = healthResponse(
        new Request("https://dashboard.example.test/api/health", { method }),
        () => {
          throw new Error("private filesystem details");
        },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe(
        method === "HEAD" ? "" : '{"status":"error"}',
      );
    },
  );
});
