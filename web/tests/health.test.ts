import { describe, expect, it } from "vitest";
import {
  healthResponse,
  readBuildDigest,
  readBuildRevision,
} from "../src/health.server.ts";

describe("dashboard build revision", () => {
  it("reads a compiled revision, not a runtime override", () => {
    const prior = process.env.BUILD_REVISION;
    process.env.BUILD_REVISION = "b".repeat(40);
    try {
      expect(readBuildRevision("a".repeat(40))).toBe("a".repeat(40));
    } finally {
      if (prior === undefined) delete process.env.BUILD_REVISION;
      else process.env.BUILD_REVISION = prior;
    }
  });

  it("does not invent a revision for a local build", () => {
    expect(readBuildRevision(null)).toBeNull();
  });

  it.each(["", "HEAD", "a".repeat(7), "A".repeat(40), "a".repeat(41), 1])(
    "refuses malformed metadata %j",
    (value) => expect(() => readBuildRevision(value)).toThrow("invalid"),
  );
});

describe("dashboard build digest", () => {
  it("reads the compiled artifact digest, not a runtime override", () => {
    expect(readBuildDigest("c".repeat(64))).toBe("c".repeat(64));
    expect(readBuildDigest(null)).toBeNull();
  });
  it.each([
    "",
    "a".repeat(40),
    "A".repeat(64),
    "__TRAINER_WEB_BUILD_DIGEST_PLACEHOLDER__",
    1,
  ])(
    "rejects unstamped or malformed digest %j",
    (value) => expect(() => readBuildDigest(value)).toThrow("invalid"),
  );
  it("exposes the immutable digest on the readiness endpoint", async () => {
    const response = healthResponse(
      new Request("https://dashboard.example.test/api/health"),
      () => null,
      () => "c".repeat(64),
    );
    expect(await response.json()).toEqual({
      status: "ok",
      revision: null,
      build: "c".repeat(64),
    });
  });
});

describe("dashboard health", () => {
  it("returns only uncached build metadata", async () => {
    const response = healthResponse(
      new Request("https://dashboard.example.test/api/health"),
      () => "a".repeat(40),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      status: "ok",
      revision: "a".repeat(40),
      build: null,
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
    "fails closed without leaking metadata errors for %s",
    async (method) => {
      const response = healthResponse(
        new Request("https://dashboard.example.test/api/health", { method }),
        () => {
          throw new Error("private build details");
        },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toBe(
        method === "HEAD" ? "" : '{"status":"error"}',
      );
    },
  );
});
