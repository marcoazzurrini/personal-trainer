import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BASE } from "./helpers.ts";
import {
  challengeHeader,
  handleMcp,
  protectedResourceMetadata,
  publicOrigin,
  TOOL_NAME,
} from "../supabase/functions/api/access/mcp.ts";

// The connector, in two halves. The dispatch is import-free and runs here
// with a stub minter, so every branch of the protocol is exercised without a
// sign-in. The route is probed live for what it does before a sign-in — the
// refusal, the pointer to where to sign in, the discovery document — which is
// all of it that a test can reach: the local stack runs without the auth
// service, so no test can present a sign-in token. The first real sign-in
// through the plugin is the end-to-end proof.

const CALLER = { subject: "user_01TEST" };
const deps = {
  issue: (subject: string) =>
    Promise.resolve({
      token: `minted-for-${subject}`,
      expires_at: "2026-09-04T12:00:00.000Z",
    }),
  baseUrl: "https://example.test/functions/v1/api",
  version: "1",
};

// deno-lint-ignore no-explicit-any
function body(outcome: { status: number; body?: unknown }): any {
  assert("body" in outcome, `a ${outcome.status} carries no body`);
  return outcome.body;
}

Deno.test("the protocol, one message at a time", async (t) => {
  await t.step(
    "initialize answers in the client's version when known",
    async () => {
      const out = await handleMcp(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {} },
        },
        CALLER,
        deps,
      );
      assertEquals(out.status, 200);
      const b = body(out);
      assertEquals(b.id, 1);
      assertEquals(b.result.protocolVersion, "2025-03-26");
      assertEquals(b.result.capabilities, { tools: {} });
      assertEquals(b.result.serverInfo.name, "personal-trainer");
      assert(typeof b.result.instructions === "string");
    },
  );

  await t.step("and in the latest it knows when not", async () => {
    const out = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2031-01-01" },
      },
      CALLER,
      deps,
    );
    assertEquals(body(out).result.protocolVersion, "2025-06-18");
  });

  await t.step("a notification is accepted with nothing to say", async () => {
    const out = await handleMcp(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      CALLER,
      deps,
    );
    assertEquals(out.status, 202);
    assert(!("body" in out));
  });

  await t.step("ping", async () => {
    const out = await handleMcp(
      { jsonrpc: "2.0", id: "p", method: "ping" },
      CALLER,
      deps,
    );
    assertEquals(body(out), { jsonrpc: "2.0", id: "p", result: {} });
  });

  await t.step("tools/list names the one tool, taking no input", async () => {
    const out = await handleMcp(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      CALLER,
      deps,
    );
    const tools = body(out).result.tools;
    assertEquals(tools.length, 1);
    assertEquals(tools[0].name, TOOL_NAME);
    assertEquals(tools[0].inputSchema, { type: "object", properties: {} });
    assertStringIncludes(tools[0].description, "curl");
  });

  await t.step(
    "tools/call mints for the caller and says where to use it",
    async () => {
      const out = await handleMcp(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: TOOL_NAME, arguments: {} },
        },
        CALLER,
        deps,
      );
      const content = body(out).result.content;
      assertEquals(content.length, 1);
      assertEquals(content[0].type, "text");
      assertEquals(JSON.parse(content[0].text), {
        token: "minted-for-user_01TEST",
        base_url: "https://example.test/functions/v1/api",
        expires_at: "2026-09-04T12:00:00.000Z",
      });
    },
  );

  await t.step("another tool name is a JSON-RPC error, in a 200", async () => {
    const out = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "log_set" },
      },
      CALLER,
      deps,
    );
    assertEquals(out.status, 200);
    assertEquals(body(out).error.code, -32602);
    assertStringIncludes(body(out).error.message, TOOL_NAME);
  });

  await t.step("an unknown method is -32601", async () => {
    const out = await handleMcp(
      { jsonrpc: "2.0", id: 6, method: "resources/list" },
      CALLER,
      deps,
    );
    assertEquals(body(out).error.code, -32601);
  });

  await t.step("not a message at all is a 400", async () => {
    for (const bad of [null, 42, "hi", [], { id: 1, method: "ping" }]) {
      const out = await handleMcp(bad, CALLER, deps);
      assertEquals(out.status, 400, JSON.stringify(bad));
      assertEquals(body(out).error.code, -32600);
    }
  });
});

Deno.test("what a client is told before it signs in", async (t) => {
  await t.step("the discovery document", () => {
    assertEquals(
      protectedResourceMetadata(
        "https://x.example/functions/v1/api/mcp",
        "https://x.example/auth/v1",
      ),
      {
        resource: "https://x.example/functions/v1/api/mcp",
        authorization_servers: ["https://x.example/auth/v1"],
        bearer_methods_supported: ["header"],
        scopes_supported: ["email"],
      },
    );
  });

  await t.step("the origin is the one callers used, not the one seen", () => {
    // Behind the gateway the runtime sees http; the outside world said https.
    const hosted = {
      protocol: "http:",
      hostname: "cawwcmsmqhrqiyjlrhba.supabase.co",
      host: "cawwcmsmqhrqiyjlrhba.supabase.co",
    };
    assertEquals(
      publicOrigin({ ...hosted, forwardedProto: null }),
      "https://cawwcmsmqhrqiyjlrhba.supabase.co",
    );
    assertEquals(
      publicOrigin({ ...hosted, forwardedProto: "https" }),
      "https://cawwcmsmqhrqiyjlrhba.supabase.co",
    );
    // The local stack really is plain http, and says so.
    const local = {
      protocol: "http:",
      hostname: "127.0.0.1",
      host: "127.0.0.1:54321",
    };
    assertEquals(
      publicOrigin({ ...local, forwardedProto: null }),
      "http://127.0.0.1:54321",
    );
    assertEquals(
      publicOrigin({ ...local, forwardedProto: "http" }),
      "http://127.0.0.1:54321",
    );
  });

  await t.step("the challenge", () => {
    assertEquals(
      challengeHeader("https://x.example/m", false),
      'Bearer resource_metadata="https://x.example/m"',
    );
    assertEquals(
      challengeHeader("https://x.example/m", true),
      'Bearer resource_metadata="https://x.example/m", error="invalid_token"',
    );
  });
});

// --- Live: the route, up to the point a sign-in would be needed --------------

async function envelope(res: Response): Promise<string> {
  const parsed = await res.json();
  assertEquals(Object.keys(parsed), ["error"], JSON.stringify(parsed));
  assertEquals(typeof parsed.error, "string");
  return parsed.error;
}

Deno.test("the connector before a sign-in", async (t) => {
  await t.step(
    "a tokenless call is refused and told where to sign in",
    async () => {
      const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      assertEquals(res.status, 401);
      const challenge = res.headers.get("www-authenticate") ?? "";
      const match = challenge.match(/^Bearer resource_metadata="([^"]+)"$/);
      assert(match !== null, `unexpected challenge: ${challenge}`);
      assert(
        match[1].endsWith("/functions/v1/api/mcp/oauth-protected-resource"),
        match[1],
      );
      assertStringIncludes(await envelope(res), "Sign in first");
    },
  );

  await t.step(
    "a token that is not a token is refused without a round trip",
    async () => {
      // Nothing here could have been checked against the sign-in server, which
      // is not running locally: the refusal comes from the shape alone.
      const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer garbage" },
        body: "{}",
      });
      assertEquals(res.status, 401);
      assertStringIncludes(
        res.headers.get("www-authenticate") ?? "",
        'error="invalid_token"',
      );
      await envelope(res);
    },
  );

  await t.step(
    "a well-formed token meets the sign-in server, or its absence",
    async () => {
      // A real-looking RS256 token, signed by nobody. In CI and on the usual
      // local stack the auth service is not running, so the keys cannot be
      // read and the answer is 503 without a challenge; with the service up
      // the same token is a plain 401. Either is the right answer to what was
      // sent, and the test says which it saw.
      const segment = (value: unknown) =>
        btoa(JSON.stringify(value)).replace(/=+$/, "");
      const token = `${segment({ alg: "RS256", kid: "k" })}.${
        segment({ iss: "x" })
      }.AAAA`;
      const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      assert([401, 503].includes(res.status), String(res.status));
      if (res.status === 503) {
        assertEquals(res.headers.get("www-authenticate"), null);
      }
      await envelope(res);
    },
  );

  await t.step("there is no stream and no session", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${BASE}/mcp`, { method });
      assertEquals(res.status, 405, method);
      await envelope(res);
    }
  });

  await t.step("the discovery document opens without credentials", async () => {
    const res = await fetch(`${BASE}/mcp/oauth-protected-resource`);
    assertEquals(res.status, 200);
    const doc = await res.json();
    assert(
      String(doc.resource).endsWith("/functions/v1/api/mcp"),
      doc.resource,
    );
    assertEquals(doc.authorization_servers.length, 1);
    assert(
      String(doc.authorization_servers[0]).endsWith("/auth/v1"),
      doc.authorization_servers[0],
    );
    assertEquals(doc.bearer_methods_supported, ["header"]);
  });
});
