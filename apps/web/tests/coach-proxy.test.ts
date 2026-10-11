import { describe, expect, it, vi } from "vitest";

import { coachResponse, coachTarget } from "../src/coach-proxy.server.ts";

const owner = { user: { id: "user_owner" } };
const env: NodeJS.ProcessEnv = { ALLOWED_SUBJECT: "user_owner" };
const origin = "https://app.example.test";

function coachReturning(response: Response) {
  return vi.fn((_request: Request) => Promise.resolve(response));
}

// The coach has no public address, so this door is its whole surface: one
// conversation, for one signed-in person, with no credentials passed through.
describe("the door to the coach", () => {
  it("maps only the one conversation's routes", () => {
    const at = (method: string, path: string) =>
      coachTarget(method, new URL(path, origin))?.href ?? null;
    expect(at("GET", "/api/coach/chat?view=updates&offset=-1")).toBe(
      "https://trainer-coach.internal/agents/coach/main?view=updates&offset=-1"
    );
    expect(at("POST", "/api/coach/chat")).toBe(
      "https://trainer-coach.internal/agents/coach/main"
    );
    expect(at("HEAD", "/api/coach/chat")).not.toBeNull();
    expect(at("POST", "/api/coach/chat/abort")).toBe(
      "https://trainer-coach.internal/agents/coach/main/abort"
    );
    expect(at("GET", "/api/coach/chat/attachments/att_123")).toBe(
      "https://trainer-coach.internal/agents/coach/main/attachments/att_123"
    );
    for (const [method, path] of [
      ["GET", "/api/coach/other"],
      ["GET", "/api/coach/chatty"],
      ["GET", "/api/coach/chat/abort"],
      ["POST", "/api/coach/chat/attachments/att_123"],
      ["DELETE", "/api/coach/chat"],
      ["PUT", "/api/coach/chat"],
      ["GET", "/api/coach/chat/attachments/a/b"],
      ["GET", "/api/coach/chat/attachments/%2e%2e"],
    ] as const) {
      expect(at(method, path), `${method} ${path}`).toBeNull();
    }
  });

  it("refuses anyone but the owner before reaching the coach", async () => {
    const coach = coachReturning(new Response("{}"));
    const request = () => new Request(`${origin}/api/coach/chat`);
    expect(
      (await coachResponse(request(), { user: null }, coach, env)).status
    ).toBe(401);
    expect(
      (
        await coachResponse(
          request(),
          { user: { id: "user_other" } },
          coach,
          env
        )
      ).status
    ).toBe(403);
    expect(
      (
        await coachResponse(
          request(),
          { user: { id: "user_owner" }, impersonator: { email: "x" } },
          coach,
          env
        )
      ).status
    ).toBe(403);
    expect((await coachResponse(request(), owner, coach, {})).status).toBe(503);
    expect(coach).not.toHaveBeenCalled();
  });

  it("says when the coach is not connected", async () => {
    const response = await coachResponse(
      new Request(`${origin}/api/coach/chat`),
      owner,
      undefined,
      env
    );
    expect(response.status).toBe(503);
  });

  it("forwards the request without cookies or credentials, and the reply without set-cookie", async () => {
    const coach = coachReturning(
      new Response("data: {}\n\n", {
        headers: {
          "Content-Type": "text/event-stream",
          "Set-Cookie": "leak=1",
          "Stream-Next-Offset": "42",
        },
      })
    );
    const response = await coachResponse(
      new Request(`${origin}/api/coach/chat?view=updates&live=sse`, {
        headers: {
          Cookie: "wos-session=secret",
          Authorization: "Bearer secret",
          Accept: "text/event-stream",
        },
      }),
      owner,
      coach,
      env
    );
    const [[forwarded]] = coach.mock.calls;
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("authorization")).toBeNull();
    expect(forwarded.headers.get("accept")).toBe("text/event-stream");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("stream-next-offset")).toBe("42");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("data: {}\n\n");
  });

  it("names the browser's conversation in an admission, not the coach's address", async () => {
    const coach = coachReturning(
      Response.json(
        {
          streamUrl: "https://trainer-coach.internal/agents/coach/main",
          offset: "0",
          submissionId: "sub_1",
        },
        { status: 202 }
      )
    );
    const response = await coachResponse(
      new Request(`${origin}/api/coach/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "user", body: "ciao" }),
      }),
      owner,
      coach,
      env
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      streamUrl: `${origin}/api/coach/chat`,
      offset: "0",
      submissionId: "sub_1",
    });
    const [[sent]] = coach.mock.calls;
    expect(await sent.json()).toEqual({
      kind: "user",
      body: "ciao",
    });
  });

  it("answers a coach that cannot be reached without its error", async () => {
    const coach = vi.fn(() =>
      Promise.reject(new Error("synthetic internal detail"))
    );
    const response = await coachResponse(
      new Request(`${origin}/api/coach/chat`),
      owner,
      coach,
      env
    );
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("synthetic internal detail");
  });
});
