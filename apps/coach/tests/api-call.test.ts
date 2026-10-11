import { describe, expect, it } from "bun:test";

import {
  ApiPathError,
  apiRequest,
  apiResult,
  apiUrl,
} from "../src/api-call.ts";

// The model picks a path under the API's base and nothing else: no host, no
// escape from /api, and the credential is applied by code it never sees.
describe("the api tool's requests", () => {
  it("joins the documents' paths to the API's base", () => {
    expect(apiUrl("/training-state").pathname).toBe("/api/training-state");
    expect(apiUrl("/sessions/12/sets").pathname).toBe("/api/sessions/12/sets");
    // A path copied with the base's own /api is forgiven, as the API does.
    expect(apiUrl("/api/training-state").pathname).toBe("/api/training-state");
    expect(apiUrl("/api/api/foods").pathname).toBe("/api/foods");
    expect(apiUrl("/apiary").pathname).toBe("/api/apiary");
    expect(apiUrl("/exercises", { q: "squat" }).search).toBe("?q=squat");
  });

  it("refuses anything that is not a path under the base", () => {
    for (const path of [
      "training-state",
      "//evil.example/x",
      "https://evil.example/api/foods",
      "/../health",
      "/foods?q=x",
      "/foods#x",
      "/foods\\x",
    ]) {
      expect(() => apiUrl(path), path).toThrow(ApiPathError);
    }
  });

  it("applies the credential and sends JSON bodies", async () => {
    const request = apiRequest(
      { method: "POST", path: "/intake", body: { request_id: "r1" } },
      "secret"
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer secret");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(await request.text())).toEqual({ request_id: "r1" });
    expect(request.redirect).toBe("manual");
  });

  it("refuses a body on a GET", () => {
    expect(() =>
      apiRequest({ method: "GET", path: "/foods", body: {} }, "secret")
    ).toThrow(ApiPathError);
  });

  it("hands the API's refusal back as it was written", async () => {
    expect(
      await apiResult(
        Response.json({ error: "Say which food." }, { status: 422 })
      )
    ).toEqual({ status: 422, body: { error: "Say which food." } });
    expect(await apiResult(new Response("plain", { status: 500 }))).toEqual({
      status: 500,
      body: "plain",
    });
  });
});
