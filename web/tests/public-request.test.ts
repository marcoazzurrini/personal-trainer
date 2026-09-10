import { describe, expect, it } from "vitest";
import { publicRequest } from "../src/public-request.server";

const callback = "https://dashboard.example.test/auth/callback";

describe("the dashboard's configured public address", () => {
  it("replaces an internal origin without trusting host or proxy headers", () => {
    const request = new Request(
      "http://internal.example.test:3000/auth/callback?code=synthetic&state=a%2Bb",
      {
        headers: {
          host: "other.example.test",
          forwarded: "host=other.example.test;proto=http",
          "x-forwarded-host": "other.example.test",
          "x-forwarded-proto": "http",
        },
      },
    );
    expect(publicRequest(request, callback).url).toBe(
      "https://dashboard.example.test/auth/callback?code=synthetic&state=a%2Bb",
    );
  });

  it("does not interpret a double-slash path as a different origin", () => {
    const request = new Request(
      "http://internal.test//other.example.test/path?q=1",
    );
    expect(publicRequest(request, callback).url).toBe(
      "https://dashboard.example.test//other.example.test/path?q=1",
    );
  });

  it("preserves POST bodies, cookies, CSRF headers and cancellation", async () => {
    const controller = new AbortController();
    const request = new Request("http://internal.test/auth/sign-out", {
      method: "POST",
      headers: {
        cookie: "wos-session=synthetic",
        origin: "https://other.example.test",
        referer: "https://other.example.test/page",
        "sec-fetch-site": "cross-site",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "source=synthetic",
      signal: controller.signal,
    });
    const rewritten = publicRequest(request, callback);
    expect(rewritten.method).toBe("POST");
    expect([...rewritten.headers]).toEqual([...request.headers]);
    expect(await rewritten.text()).toBe("source=synthetic");
    controller.abort();
    expect(rewritten.signal.aborted).toBe(true);
  });

  it("keeps ordinary local development and custom public ports working", () => {
    for (
      const origin of [
        "http://localhost:3000",
        "http://127.0.0.1:4000",
        "http://[::1]:3000",
        "https://dashboard.example.test:8443",
      ]
    ) {
      const request = new Request(`${origin}/?window=30`);
      expect(publicRequest(request, `${origin}/auth/callback`)).toBe(request);
      expect(
        publicRequest(
          new Request("http://internal.test/"),
          `${origin}/auth/callback`,
        ).url,
      ).toBe(`${origin}/`);
    }
  });

  it("refuses missing or unsafe configuration rather than falling back to a request header", () => {
    const request = new Request("https://dashboard.example.test/");
    for (
      const value of [
        undefined,
        "",
        "/auth/callback",
        "not a URL",
        "http://dashboard.example.test/auth/callback",
        "http://localhost.other.example.test/auth/callback",
        "ftp://localhost/auth/callback",
        "https://user:secret@dashboard.example.test/auth/callback",
        "https://dashboard.example.test/",
        "https://dashboard.example.test/other/callback",
        `${callback}?next=other`,
        `${callback}#fragment`,
      ]
    ) {
      expect(() => publicRequest(request, value)).toThrow(
        "WORKOS_REDIRECT_URI must be the dashboard's HTTPS /auth/callback URL",
      );
    }
  });
});
