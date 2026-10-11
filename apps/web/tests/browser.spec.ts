import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import { sessionEncryption } from "@workos/authkit-session";

import { stopWorker, workerFixture } from "./worker-fixture.ts";

const password = "synthetic-browser-test-cookie-secret-not-a-real-credential";
const user = {
  id: "user_test",
  email: "synthetic@example.test",
  emailVerified: true,
  firstName: "Test",
  lastName: "User",
  profilePictureUrl: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  externalId: null,
  lastSignInAt: null,
  metadata: {},
};
let upstream: Server;
let app: ChildProcess;
let appUrl: string;
let proxyApp: ChildProcess;
let proxyAppUrl: string;
const publicOrigin = "https://dashboard.example.test";
let providerUrl: string;
let sign: (subject?: string, expired?: boolean) => Promise<string>;
let refreshes = 0;
let output = "";
const functions: { id: string; name: string }[] = [];
const fixtures: Awaited<ReturnType<typeof workerFixture>>[] = [];
async function listen(server: Server): Promise<string> {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No test port");
  }
  return `http://127.0.0.1:${address.port}`;
}

function sessionFunction() {
  const entry = functions.find((candidate) => candidate.name === "loadSession");
  if (!entry) {
    throw new Error("The compiled loadSession function is missing.");
  }
  return entry;
}

async function session(
  context: BrowserContext,
  subject = user.id,
  expired = false
) {
  const accessToken = await sign(subject, expired);
  const cookie = await sessionEncryption.sealData(
    {
      user: { ...user, id: subject },
      accessToken,
      refreshToken: "synthetic-refresh-token",
    },
    { password }
  );
  await context.addCookies([
    {
      name: "wos-session",
      value: encodeURIComponent(cookie),
      url: appUrl,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return accessToken;
}

async function startApp(origin?: string) {
  const reservation = createServer();
  const url = await listen(reservation);
  await promisify(reservation.close.bind(reservation))();
  const fixture = await workerFixture(
    {
      WORKOS_CLIENT_ID: "client_test",
      WORKOS_API_KEY: "sk_test_synthetic",
      WORKOS_API_HOSTNAME: "127.0.0.1",
      WORKOS_API_PORT: new URL(providerUrl).port,
      WORKOS_API_HTTPS: "false",
      WORKOS_REDIRECT_URI: `${origin ?? url}/auth/callback`,
      WORKOS_COOKIE_PASSWORD: password,
      ALLOWED_SUBJECT: user.id,
    },
    { coach: true }
  );
  fixtures.push(fixture);
  const child = fixture.serve(new URL(url).port);
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  return { child, url };
}

test.beforeAll(async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "browser-test",
    alg: "ES256",
  };
  const encode = (value: Record<string, string | number>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  sign = async (subject = user.id, expired = false) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = `${encode({ alg: "ES256", kid: jwk.kid })}.${encode({
      iss: providerUrl,
      client_id: "client_test",
      sub: subject,
      sid: "session_test",
      iat: now - 7200,
      exp: expired ? now - 3600 : now + 600,
    })}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(payload)
    );
    return `${payload}.${Buffer.from(signature).toString("base64url")}`;
  };
  upstream = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/sso/jwks/client_test") {
      return response.end(JSON.stringify({ keys: [jwk] }));
    }
    if (request.url === "/user_management/authenticate") {
      refreshes += 1;
      return response.end(
        JSON.stringify({
          user: {
            ...user,
            email_verified: true,
            first_name: "Test",
            last_name: "User",
          },
          access_token: await sign(),
          refresh_token: "synthetic-rotated-refresh-token",
          authentication_method: "Password",
        })
      );
    }
    response.statusCode = 404;
    response.end("{}");
  });
  providerUrl = await listen(upstream);
  ({ child: app, url: appUrl } = await startApp());
  ({ child: proxyApp, url: proxyAppUrl } = await startApp(publicOrigin));
  for (const url of [appUrl, proxyAppUrl]) {
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(url);
            await response.body?.cancel();
            return response.status;
          } catch {
            return 0;
          }
        },
        {
          timeout: 20_000,
          message:
            "The production web build starts with synthetic configuration",
        }
      )
      .toBe(200);
  }
  // Probe the compiled RPC inventory, including the SDK helpers not imported by
  // the page. Their generated IDs are not secrets or authorization boundaries.
  for (const file of await readdir(".output/server/_ssr")) {
    if (!file.endsWith(".mjs")) {
      continue;
    }
    const text = await readFile(`.output/server/_ssr/${file}`, "utf-8");
    for (const match of text.matchAll(
      /createServerRpc\(\{\s*id: "(?<id>[^"]+)",\s*name: "(?<name>[^"]+)"/gu
    )) {
      functions.push({ id: match[1], name: match[2] });
    }
  }
  expect(functions.some((fn) => fn.name === "loadSession")).toBe(true);
});

test.afterAll(async () => {
  await writeFile("/tmp/trainer-browser-server.log", output);
  for (const child of [app, proxyApp]) {
    await stopWorker(child);
  }
  for (const fixture of fixtures) {
    await fixture.dispose();
  }
  if (upstream) {
    await promisify(upstream.close.bind(upstream))();
  }
});

test("public health reports uncached build metadata without a session", async ({
  request,
}) => {
  // The suite runs against a build made with the same BUILD_REVISION, if any.
  const revision = process.env.BUILD_REVISION ?? null;
  for (const url of [appUrl, proxyAppUrl]) {
    const response = await request.get(`${url}/api/health`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(await response.json()).toEqual({ status: "ok", revision });
    const refused = await request.post(`${url}/api/health`);
    expect(refused.status()).toBe(405);
  }
});

test("installation metadata and PT icons are public without reading personal data", async ({
  page,
  request,
}) => {
  await page.goto(appUrl);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest"
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/icons/apple-touch-icon.png"
  );
  const response = await request.get(`${appUrl}/manifest.webmanifest`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain(
    "application/manifest+json"
  );
  expect(response.headers()["set-cookie"]).toBeUndefined();
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: "/",
    name: "Trainer",
    short_name: "PT",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#09090b",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  });
  for (const [path, size] of [
    ["/icons/icon-192.png", 192],
    ["/icons/icon-512.png", 512],
    ["/icons/apple-touch-icon.png", 180],
  ] as const) {
    const icon = await request.get(`${appUrl}${path}`);
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/png");
    expect(icon.headers()["set-cookie"]).toBeUndefined();
    const png = await icon.body();
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    const dimensions = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, path);
    expect(dimensions).toEqual([size, size]);
  }
});

test("client assets contain no server-only configuration or coach access", async () => {
  for (const file of await readdir(".output/public/assets")) {
    if (!file.endsWith(".js")) {
      continue;
    }
    const source = await readFile(`.output/public/assets/${file}`, "utf-8");
    for (const forbidden of [
      "WORKOS_API_KEY",
      "WORKOS_COOKIE_PASSWORD",
      "WORKOS_REDIRECT_URI",
      "publicRequest",
      "readBuildRevision",
      "build-revision.txt",
      "ALLOWED_SUBJECT",
      "coachResponse",
      "trainer-coach.internal",
      "COACH_AGENT_TOKEN",
      "ANTHROPIC_API_KEY",
      "DATABASE_URL",
    ]) {
      expect(source, `${file} contains ${forbidden}`).not.toContain(forbidden);
    }
  }
});

test("anonymous visitors reach neither the coach nor personal data, and cross-site writes fail", async ({
  page,
  request,
}) => {
  const response = await page.goto(appUrl);
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true })
  ).toBeVisible();
  const refused = await request.post(`${appUrl}/auth/sign-out`, {
    headers: {
      origin: "https://other.example.test",
      "sec-fetch-site": "cross-site",
    },
  });
  expect(refused.status()).toBe(403);
  const read = sessionFunction();
  const deniedRead = await request.get(`${appUrl}/_serverFn/${read.id}`, {
    headers: {
      origin: "https://other.example.test",
      "sec-fetch-site": "cross-site",
    },
  });
  expect(deniedRead.status()).toBe(403);
  const directRead = await request.get(`${appUrl}/_serverFn/${read.id}`, {
    headers: { "sec-fetch-site": "same-origin", "x-tsr-serverFn": "true" },
  });
  expect(await directRead.text()).toContain("signed-out");
  const coach = await request.get(`${appUrl}/api/coach/chat`);
  expect(coach.status()).toBe(401);
  expect(coach.headers()["cache-control"]).toBe("private, no-store");
  const sent = await request.post(`${appUrl}/api/coach/chat`, {
    headers: { origin: appUrl },
    data: { kind: "user", body: "ciao" },
  });
  expect(sent.status()).toBe(401);
});

test("the owner chats with the coach at phone width, without credentials in HTML or RPC responses", async ({
  page,
  context,
}) => {
  const token = await session(context);
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto(appUrl);
  if (!response) {
    throw new Error("App navigation did not return a response.");
  }
  const html = await response.text();
  expect(html).not.toContain(token);
  expect(html).not.toContain("synthetic-refresh-token");
  const composer = page.getByRole("textbox", { name: "Message your coach" });
  await expect(composer).toBeVisible();
  await expect(
    page.getByRole("button", { name: "I want to train", exact: true })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= globalThis.innerWidth
    )
  ).toBe(true);
  // Without a model key the coach admits the message and then fails the
  // reply; the thread must say so rather than wait forever.
  await composer.fill("Ciao, voglio allenarmi");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Ciao, voglio allenarmi")).toBeVisible();
  await expect(
    page.getByText("The coach could not finish this reply", { exact: false })
  ).toBeVisible({ timeout: 20_000 });
  // The conversation is durable: a reload shows the same thread.
  await page.reload();
  await expect(page.getByText("Ciao, voglio allenarmi")).toBeVisible();
  // The inventory must include SDK token helpers, and every one must be closed.
  expect(functions.some((fn) => fn.name === "getAuth")).toBe(true);
  for (const fn of functions.filter(
    (candidate) => candidate.name !== "loadSession"
  )) {
    for (const method of ["GET", "POST"]) {
      const denied = await context.request.fetch(
        `${appUrl}/_serverFn/${fn.id}`,
        {
          method,
          headers: {
            "sec-fetch-site": "same-origin",
            origin: appUrl,
            "x-tsr-serverFn": "true",
          },
        }
      );
      expect(denied.status()).toBe(403);
      expect(await denied.text()).not.toContain(token);
    }
  }
  const read = sessionFunction();
  const rpc = await context.request.get(`${appUrl}/_serverFn/${read.id}`, {
    headers: { "sec-fetch-site": "same-origin", "x-tsr-serverFn": "true" },
  });
  expect(rpc.status()).toBe(200);
  expect(rpc.headers()["cache-control"]).toContain("no-store");
  const payload = await rpc.text();
  expect(payload).toContain("ready");
  expect(payload).not.toContain(token);
  // The coach's surface is the one conversation and nothing else.
  for (const path of [
    "/api/coach/other",
    "/api/coach/chat/extra",
    "/api/coach/chat/attachments/../abort",
  ]) {
    const outside = await context.request.get(`${appUrl}${path}`);
    expect(outside.status(), path).toBe(404);
  }
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(async () => ({
      workers: (await navigator.serviceWorker.getRegistrations()).length,
      caches: await caches.keys(),
      localStorage: localStorage.length,
      databases: await indexedDB.databases(),
    }))
  ).toEqual({ workers: 0, caches: [], localStorage: 0, databases: [] });
  await page.screenshot({ path: "/tmp/trainer-chat.png", fullPage: true });
  expect(output).not.toContain(token);
  expect(output).not.toContain("synthetic-refresh-token");
});

test("sign-in creates a PKCE verifier and an invalid callback fails closed", async ({
  request,
}) => {
  const response = await request.get(`${appUrl}/auth/sign-in`, {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(302);
  expect(response.headers()["location"]).toContain("code_challenge=");
  expect(response.headers()["set-cookie"]).toContain("HttpOnly");
  expect(response.headers()["set-cookie"]).toContain("SameSite=Lax");
  const failed = await request.get(
    `${appUrl}/auth/callback?code=synthetic-invalid&state=wrong`,
    { maxRedirects: 0 }
  );
  expect(failed.status()).toBe(400);
  expect(await failed.text()).toContain("Sign-in failed");
});

test("a completed authorization-code callback creates a session and opens the chat", async ({
  context,
  page,
}) => {
  const started = await context.request.get(`${appUrl}/auth/sign-in`, {
    maxRedirects: 0,
  });
  const state = new URL(started.headers()["location"]).searchParams.get(
    "state"
  );
  expect(state).toBeTruthy();
  if (state === null) {
    throw new Error("Sign-in did not return state.");
  }
  const callback = await context.request.get(
    `${appUrl}/auth/callback?${new URLSearchParams({
      code: "synthetic-code",
      state,
    })}`,
    { maxRedirects: 0 }
  );
  expect(callback.status()).toBe(307);
  expect(callback.headers()["location"]).toBe(`${appUrl}/`);
  const cookie = (await context.cookies()).find(
    (candidate) => candidate.name === "wos-session"
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  await page.goto(appUrl);
  await expect(
    page.getByRole("textbox", { name: "Message your coach" })
  ).toBeVisible();
});

test("a proxied sign-in returns to the configured HTTPS address despite forged host headers", async ({
  request,
}) => {
  // The socket is HTTP, as it is behind a TLS-terminating proxy. Neither Host
  // nor forwarded headers may choose where the SDK sends the browser next.
  for (const host of [new URL(publicOrigin).host, "other.example.test"]) {
    const headers = {
      host,
      "x-forwarded-host": host,
      "x-forwarded-proto": "https",
      forwarded: `host=${host};proto=https`,
    };
    const started = await request.get(`${proxyAppUrl}/auth/sign-in`, {
      headers,
      maxRedirects: 0,
    });
    expect(started.status()).toBe(302);
    const authorization = new URL(started.headers()["location"]);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${publicOrigin}/auth/callback`
    );
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();
    if (state === null) {
      throw new Error("Proxied sign-in did not return state.");
    }
    expect(started.headers()["set-cookie"]).toContain("Secure");
    // Forward cookies explicitly: this test intentionally sends the backend an
    // HTTP request, not a browser's public HTTPS request. No external host is hit.
    const verifier = started
      .headersArray()
      .filter(({ name }) => name.toLowerCase() === "set-cookie")
      .map(({ value }) => value.split(";")[0])
      .join("; ");
    const callback = await request.get(
      `${proxyAppUrl}/auth/callback?${new URLSearchParams({
        code: "synthetic-code",
        state,
      })}`,
      { headers: { ...headers, cookie: verifier }, maxRedirects: 0 }
    );
    expect(callback.status()).toBe(307);
    expect(callback.headers()["location"]).toBe(`${publicOrigin}/`);
    const cookie = callback
      .headersArray()
      .find(
        ({ name, value }) =>
          name.toLowerCase() === "set-cookie" &&
          value.startsWith("wos-session=")
      )?.value;
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    if (cookie === undefined) {
      throw new Error("Callback did not return a session cookie.");
    }
    const dashboard = await request.get(proxyAppUrl, {
      headers: { ...headers, cookie: cookie.split(";")[0] },
    });
    expect(dashboard.status()).toBe(200);
    expect(await dashboard.text()).toContain("Sign out");
    const logout = await request.post(`${proxyAppUrl}/auth/sign-out`, {
      headers: {
        ...headers,
        cookie: cookie.split(";")[0],
        origin: publicOrigin,
      },
      form: { source: "synthetic-proxy-test" },
      maxRedirects: 0,
    });
    expect(logout.status()).toBe(303);
    expect(logout.headers()["set-cookie"]).toMatch(
      /Max-Age=0|Expires=Thu, 01 Jan 1970/iu
    );
  }
});

test("proxied CSRF checks accept only the public origin, including Origin and Referer fallbacks", async ({
  request,
}) => {
  const read = sessionFunction();
  const token = await sign();
  const cookie = `wos-session=${encodeURIComponent(
    await sessionEncryption.sealData(
      {
        user,
        accessToken: token,
        refreshToken: "synthetic-refresh-token",
      },
      { password }
    )
  )}`;
  const cases: { headers: Record<string, string>; allowed: boolean }[] = [
    { headers: { origin: publicOrigin }, allowed: true },
    { headers: { referer: `${publicOrigin}/` }, allowed: true },
    { headers: { origin: "https://other.example.test" }, allowed: false },
    { headers: { referer: "https://other.example.test/" }, allowed: false },
    {
      headers: { origin: publicOrigin.replace("https:", "http:") },
      allowed: false,
    },
    { headers: { origin: proxyAppUrl }, allowed: false },
    { headers: { origin: "null" }, allowed: false },
    { headers: {}, allowed: false },
    {
      headers: { origin: publicOrigin, "sec-fetch-site": "cross-site" },
      allowed: false,
    },
  ];
  for (const { headers, allowed } of cases) {
    const sent = {
      host: "other.example.test",
      "x-forwarded-host": "other.example.test",
      "x-forwarded-proto": "https",
      cookie,
      ...headers,
    };
    const rpc = await request.get(`${proxyAppUrl}/_serverFn/${read.id}`, {
      headers: { ...sent, "x-tsr-serverFn": "true" },
    });
    expect(rpc.status()).toBe(allowed ? 200 : 403);
    const payload = await rpc.text();
    expect(payload).not.toContain(token);
    if (allowed) {
      expect(rpc.headers()["cache-control"]).toContain("no-store");
      expect(payload).toContain("ready");
    }
    // A message to the coach is a write: only the public origin may send it.
    if (!allowed) {
      const message = await request.post(`${proxyAppUrl}/api/coach/chat`, {
        headers: sent,
        data: { kind: "user", body: "cross-site" },
      });
      expect(message.status()).toBe(403);
    }
    const logout = await request.post(`${proxyAppUrl}/auth/sign-out`, {
      headers: sent,
      maxRedirects: 0,
    });
    expect(logout.status()).toBe(allowed ? 303 : 403);
  }
});

test("another valid account cannot open the app or reach the coach", async ({
  page,
  context,
}) => {
  await session(context, "user_other");
  await page.goto(appUrl);
  await expect(page.getByRole("alert")).toContainText(
    "This account cannot open"
  );
  const coach = await context.request.get(`${appUrl}/api/coach/chat`);
  expect(coach.status()).toBe(403);
  expect(await coach.text()).not.toContain("Ciao");
});

test("expired sessions refresh through the SDK and replace the HttpOnly cookie", async ({
  page,
  context,
}) => {
  await session(context, user.id, true);
  const before = refreshes;
  await page.goto(appUrl);
  await expect(
    page.getByRole("textbox", { name: "Message your coach" })
  ).toBeVisible();
  expect(refreshes).toBeGreaterThan(before);
  const cookie = (await context.cookies()).find(
    (candidate) => candidate.name === "wos-session"
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
});

test("sign-out clears the local session before redirecting to WorkOS", async ({
  context,
}) => {
  await session(context);
  const response = await context.request.post(`${appUrl}/auth/sign-out`, {
    headers: { origin: appUrl },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(response.headers()["set-cookie"]).toMatch(
    /Max-Age=0|Expires=Thu, 01 Jan 1970/iu
  );
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "wos-session" && cookie.value
    )
  ).toBe(false);
  expect((await context.request.get(`${appUrl}/api/coach/chat`)).status()).toBe(
    401
  );
});
