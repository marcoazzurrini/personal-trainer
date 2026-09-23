import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { migrationStatements } from "./local.mjs";

let script, migrations, pair, jwk;
const issuer = "https://identity.invalid";
const resource = "https://trainer.invalid/api/mcp";
before(async () => {
  const compiled = await build({
    entryPoints: [
      fileURLToPath(new URL("./access.test.worker.ts", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
  });
  assert.ok(
    !Object.keys(compiled.metafile.inputs).some((p) =>
      /api\/db\.ts|postgres/.test(p)
    ),
  );
  script = compiled.outputFiles[0].text;
  assert.doesNotMatch(script, /Deno\./);
  const dir = new URL("./migrations/", import.meta.url);
  migrations = migrationStatements(
    (
      await Promise.all(
        (await readdir(dir))
          .filter((p) => p.endsWith(".sql"))
          .sort()
          .map((p) => readFile(new URL(p, dir), "utf8")),
      )
    ).join("\n"),
  );
  pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  jwk = {
    ...(await webcrypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "local-key",
  };
});
async function sign(claims) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const text = `${encode({ alg: "ES256", kid: "local-key" })}.${
    encode({
      iss: issuer,
      sub: "owner",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    })
  }`;
  return `${text}.${
    Buffer.from(
      await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        Buffer.from(text),
      ),
    ).toString("base64url")
  }`;
}
async function fixture(t) {
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-08-03",
      d1Databases: { DB: randomUUID() },
      bindings: {
        MCP: {
          issuer,
          allowedSubject: "owner",
          jwksUrl: `${issuer}/jwks`,
          publicOrigin: "https://trainer.invalid",
        },
        WEB: {
          issuer,
          clientId: "dashboard",
          jwksUrl: `${issuer}/jwks`,
          allowedSubject: "owner",
        },
      },
      outboundService(request) {
        assert.equal(request.url, `${issuer}/jwks`);
        return Response.json({ keys: [jwk] });
      },
    }),
    cf: false,
    telemetry: { enabled: false },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await db.batch(migrations.map((sql) => db.prepare(sql)));
  const call = (path, options = {}) =>
    mf.dispatchFetch(`https://trainer.invalid${path}`, options);
  const token = async (method, value, clock) =>
    (
      await call(`/tokens/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(clock ? { "x-clock": clock } : {}),
        },
        body: JSON.stringify({ value }),
      })
    ).json();
  return { db, call, token };
}

test("D1 token mint stores only hash; expiry, cleanup and revocation persist", async (t) => {
  const { db, token } = await fixture(t);
  const minted = await token("mint", "owner");
  assert.match(minted.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.expires_at, "2026-08-31T12:00:00.000Z");
  const row = await db.prepare("SELECT * FROM api_tokens").first();
  assert.equal(
    row.token_hash,
    createHash("sha256").update(minted.token).digest("hex"),
  );
  assert.ok(!JSON.stringify(row).includes(minted.token));
  assert.deepEqual(await token("verify", minted.token), { subject: "owner" });
  assert.equal(await token("verify", `${minted.token}wrong`), null);
  assert.equal(await token("verify", minted.token, minted.expires_at), null);
  await token("mint", "owner", "2026-09-01T12:00:00Z");
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM api_tokens").first()).n,
    1,
  );
  await db.prepare("DELETE FROM api_tokens").run();
  assert.equal(await token("verify", minted.token), null);
});

test("dashboard and connector credentials stay distinct; only exact GET bodyweight allowed", async (t) => {
  const { call } = await fixture(t);
  const dashboard = await sign({
    client_id: "dashboard",
    sid: "session-local",
  });
  assert.equal(
    (
      await call("/api/bodyweight", {
        headers: { authorization: `Bearer ${dashboard}` },
      })
    ).status,
    200,
  );
  for (
    const [method, path] of [
      ["POST", "/api/bodyweight"],
      ["HEAD", "/api/bodyweight"],
      ["OPTIONS", "/api/bodyweight"],
      ["GET", "/api/exercises"],
      ["GET", "/api/bodyweight/"],
    ]
  ) {
    assert.equal(
      (
        await call(path, {
          method,
          headers: { authorization: `Bearer ${dashboard}` },
        })
      ).status,
      403,
      `${method} ${path}`,
    );
  }
  for (
    const claims of [
      { aud: resource },
      { client_id: "wrong", sid: "s" },
      { client_id: "dashboard" },
      { client_id: "dashboard", sid: "s", exp: 1 },
      { client_id: "dashboard", sid: "s", iss: "https://wrong.invalid" },
      { client_id: "dashboard", sid: "s", aud: resource },
    ]
  ) {
    assert.equal(
      (
        await call("/api/bodyweight", {
          headers: { authorization: `Bearer ${await sign(claims)}` },
        })
      ).status,
      401,
    );
  }
  assert.equal(
    (
      await call("/api/bodyweight", {
        headers: {
          authorization: `Bearer ${await sign({
            client_id: "dashboard",
            sid: "s",
            sub: "other",
          })}`,
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/api/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${dashboard}` },
        body: "{}",
      })
    ).status,
    401,
  );
});

test("discovery fixes resource and sign-in alone mints a coach token", async (t) => {
  const { call, token, db } = await fixture(t);
  const discovery = await (
    await call("/api/mcp/oauth-protected-resource")
  ).json();
  assert.equal(discovery.resource, resource);
  assert.deepEqual(discovery.authorization_servers, [issuer]);
  const challenge = await call("/api/mcp");
  assert.equal(challenge.status, 401);
  assert.match(
    challenge.headers.get("www-authenticate"),
    /trainer\.invalid\/api\/mcp\/oauth-protected-resource/,
  );
  const invoke = (bearer) =>
    call("/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_api_token", arguments: {} },
      }),
    });
  for (
    const claims of [
      { aud: "https://other.invalid/api/mcp" },
      { aud: resource, iss: "https://wrong.invalid" },
    ]
  ) {
    assert.equal((await invoke(await sign(claims))).status, 401);
  }
  assert.equal(
    (await invoke(await sign({ aud: resource, sub: "other" }))).status,
    403,
  );
  const response = await invoke(await sign({ aud: resource }));
  assert.equal(response.status, 200);
  const rpc = await response.json();
  const minted = JSON.parse(rpc.result.content[0].text);
  assert.equal(minted.base_url, "https://trainer.invalid/api");
  assert.deepEqual(await token("verify", minted.token), { subject: "owner" });
  assert.equal((await invoke(minted.token)).status, 401);
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM api_tokens").first()).n,
    1,
  );
  for (
    const [left, right, expected] of [
      ["secret", "secret", true],
      ["secret", "secreu", false],
      ["secret", "", false],
    ]
  ) {
    assert.equal(
      await (
        await call("/compare", {
          method: "POST",
          body: JSON.stringify({ left, right }),
        })
      ).json(),
      expected,
    );
  }
});
