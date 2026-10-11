import { test } from "node:test";

import type { Bindings } from "../src/environment.ts";
import { assert, assertEquals } from "./assertions.ts";

// The in-app coach's secret opens the API exactly as a minted coach token does,
// and nothing weaker than a real secret is ever accepted in its place.
test("the in-app coach's configured secret is the only extra way in", async () => {
  // The helper verifies the disposable Worker/D1 identity before fixture reads.
  const { TOKEN } = await import("./helpers.ts");
  const { handleRequest } = await import("../src/index.ts");
  const { database } = await import("./d1.ts");
  const secret = "agent_secret_0123456789abcdefghijklmnopqrstuvwxyz";
  const call = async (env: Bindings, token: string, method = "GET") => {
    const response = await handleRequest(
      new Request("http://localhost/api/training-state", {
        method,
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
      {
        waitUntil() {
          /* empty */
        },
        passThroughOnException() {
          /* empty */
        },
      }
    );
    return { status: response.status, text: await response.text() };
  };

  const configured: Bindings = { DB: database, COACH_AGENT_TOKEN: secret };
  assertEquals((await call(configured, secret)).status, 200);
  // A minted coach token keeps working beside it.
  assertEquals((await call(configured, TOKEN)).status, 200);

  for (const wrong of [
    `${secret}x`,
    secret.slice(0, -1),
    secret.toUpperCase(),
    "",
  ]) {
    const denied = await call(configured, wrong);
    assertEquals(denied.status, 401, wrong);
    assert(!denied.text.includes(secret));
  }

  // Unset, too short, or shaped like a JWT: the credential is off, not weakened.
  const short = "a".repeat(31);
  const dotted = `${secret}.x`;
  for (const value of [undefined, short, dotted]) {
    const env: Bindings = { DB: database, COACH_AGENT_TOKEN: value };
    assertEquals((await call(env, value ?? secret)).status, 401, String(value));
  }
});
