import { type BrowserContext, expect, test } from "@playwright/test";
import { sessionEncryption } from "@workos/authkit-session";
import { createServer, type Server } from "node:http";
import { type ChildProcess, spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";

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
let reads = 0;
let refreshes = 0;
let failure = false;
let empty = false;
let missingTrend = false;
let output = "";
const functions: Array<{ id: string; name: string }> = [];
const weight = {
  bodyweight: [
    {
      id: 1,
      value_kg: 80.2,
      measured_at: "2026-09-01T06:30:00Z",
      source: "synthetic",
    },
    {
      id: 2,
      value_kg: 80.8,
      measured_at: "2026-09-02T06:30:00Z",
      source: "synthetic",
    },
    {
      id: 3,
      value_kg: 79.9,
      measured_at: "2026-09-04T06:30:00Z",
      source: "synthetic",
    },
  ],
  trend: [
    { day: "2026-09-01", weight_kg: 80.2, trend_kg: 80.2, interpolated: false },
    {
      day: "2026-09-02",
      weight_kg: 80.8,
      trend_kg: 80.26,
      interpolated: false,
    },
    {
      day: "2026-09-03",
      weight_kg: 80.35,
      trend_kg: 80.269,
      interpolated: true,
    },
    {
      day: "2026-09-04",
      weight_kg: 79.9,
      trend_kg: 80.2321,
      interpolated: false,
    },
  ],
};

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("No test port");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    })
  );
}

async function session(
  context: BrowserContext,
  subject = user.id,
  expired = false,
) {
  const accessToken = await sign(subject, expired);
  const cookie = await sessionEncryption.sealData({
    user: { ...user, id: subject },
    accessToken,
    refreshToken: "synthetic-refresh-token",
  }, { password });
  await context.addCookies([{
    name: "wos-session",
    value: encodeURIComponent(cookie),
    url: appUrl,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  return accessToken;
}

async function startApp(origin?: string) {
  const reservation = createServer();
  const url = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: new URL(url).port,
      WORKOS_CLIENT_ID: "client_test",
      WORKOS_API_KEY: "sk_test_synthetic",
      WORKOS_API_HOSTNAME: "127.0.0.1",
      WORKOS_API_PORT: new URL(providerUrl).port,
      WORKOS_API_HTTPS: "false",
      WORKOS_REDIRECT_URI: `${origin ?? url}/auth/callback`,
      WORKOS_COOKIE_PASSWORD: password,
      ALLOWED_SUBJECT: user.id,
      TRAINER_API_ORIGIN: providerUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    ["sign", "verify"],
  );
  const jwk = {
    ...await crypto.subtle.exportKey("jwk", keys.publicKey),
    kid: "browser-test",
    alg: "ES256",
  };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  sign = async (subject = user.id, expired = false) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = `${encode({ alg: "ES256", kid: jwk.kid })}.${
      encode({
        iss: providerUrl,
        client_id: "client_test",
        sub: subject,
        sid: "session_test",
        iat: now - 7200,
        exp: expired ? now - 3600 : now + 600,
      })
    }`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(payload),
    );
    return `${payload}.${Buffer.from(signature).toString("base64url")}`;
  };
  upstream = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/sso/jwks/client_test") {
      return response.end(JSON.stringify({ keys: [jwk] }));
    }
    if (request.url === "/user_management/authenticate") {
      refreshes++;
      return response.end(JSON.stringify({
        user: {
          ...user,
          email_verified: true,
          first_name: "Test",
          last_name: "User",
        },
        access_token: await sign(),
        refresh_token: "synthetic-rotated-refresh-token",
        authentication_method: "Password",
      }));
    }
    if (request.url === "/api/bodyweight") {
      reads++;
      if (!request.headers.authorization?.startsWith("Bearer ")) {
        response.statusCode = 401;
        return response.end("{}");
      }
      if (failure) {
        response.statusCode = 503;
        return response.end('{"error":"private upstream detail"}');
      }
      return response.end(
        JSON.stringify(
          empty
            ? { bodyweight: [], trend: [] }
            : missingTrend
            ? { ...weight, trend: [] }
            : weight,
        ),
      );
    }
    response.statusCode = 404;
    response.end("{}");
  });
  providerUrl = await listen(upstream);
  ({ child: app, url: appUrl } = await startApp());
  ({ child: proxyApp, url: proxyAppUrl } = await startApp(publicOrigin));
  for (const url of [appUrl, proxyAppUrl]) {
    await expect.poll(async () => {
      try {
        const response = await fetch(url);
        await response.body?.cancel();
        return response.status;
      } catch {
        return 0;
      }
    }, {
      timeout: 20_000,
      message: "The production web build starts with synthetic configuration",
    }).toBe(200);
  }
  // Probe the compiled RPC inventory, including the SDK helpers not imported by
  // the page. Their generated IDs are not secrets or authorization boundaries.
  for (const file of await readdir(".output/server/_ssr")) {
    if (!file.endsWith(".mjs")) continue;
    const text = await readFile(`.output/server/_ssr/${file}`, "utf8");
    for (
      const match of text.matchAll(
        /createServerRpc\(\{\s*id: "([^"]+)",\s*name: "([^"]+)"/g,
      )
    ) {
      functions.push({ id: match[1], name: match[2] });
    }
  }
  expect(functions.some((fn) => fn.name === "loadDashboard")).toBe(true);
});

test.afterAll(async () => {
  await writeFile("/tmp/trainer-browser-server.log", output);
  for (const child of [app, proxyApp]) {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  }
  if (upstream) {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test.beforeEach(() => {
  failure = false;
  empty = false;
  missingTrend = false;
});

test("public health reports uncached build metadata without a session or API read", async ({ request }) => {
  const before = reads;
  for (const url of [appUrl, proxyAppUrl]) {
    const response = await request.get(`${url}/api/health`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(await response.json()).toEqual({ status: "ok", revision: null });
    const refused = await request.post(`${url}/api/health`);
    expect(refused.status()).toBe(405);
  }
  expect(reads).toBe(before);
});

test("client assets contain no server-only configuration or API implementation", async () => {
  for (const file of await readdir(".output/public/assets")) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(`.output/public/assets/${file}`, "utf8");
    for (
      const forbidden of [
        "WORKOS_API_KEY",
        "WORKOS_COOKIE_PASSWORD",
        "WORKOS_REDIRECT_URI",
        "publicRequest",
        "readBuildRevision",
        "build-revision.txt",
        "TRAINER_API_ORIGIN",
        "ALLOWED_SUBJECT",
        "readDashboard",
        "DATABASE_URL",
      ]
    ) {
      expect(source, `${file} contains ${forbidden}`).not.toContain(forbidden);
    }
  }
});

test("anonymous reads return no personal data and cross-site writes fail", async ({ page, request }) => {
  const before = reads;
  const response = await page.goto(appUrl);
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("link", { name: "Sign in", exact: true }))
    .toBeVisible();
  expect(reads).toBe(before);
  const refused = await request.post(`${appUrl}/auth/sign-out`, {
    headers: {
      origin: "https://other.example.test",
      "sec-fetch-site": "cross-site",
    },
  });
  expect(refused.status()).toBe(403);
  const read = functions.find((fn) => fn.name === "loadDashboard")!;
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
  expect(reads).toBe(before);
});

test("the owner sees real chart data at phone width, without credentials in HTML or RPC responses", async ({ page, context, request }) => {
  const token = await session(context);
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto(appUrl);
  const html = await response!.text();
  expect(html).not.toContain(token);
  expect(html).not.toContain("synthetic-refresh-token");
  await expect(page.getByRole("heading", { name: "Weight history" }))
    .toBeVisible();
  await expect(page.locator("svg").first()).toBeVisible();
  // Configured scale instances retain padding; a factory would infer tight
  // bounds and clip the highest and lowest measurement against the frame.
  await expect(page.locator("svg").first()).toContainText("81.0");
  await page.getByRole("button", { name: "30 days", exact: true }).click();
  await expect(page.getByRole("button", { name: "30 days", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByText("Measurements in this window", { exact: false }).click();
  await expect(page.getByRole("table")).toContainText("79.9");
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= globalThis.innerWidth
    ),
  ).toBe(true);
  // The inventory must include SDK token helpers, and every one must be closed.
  expect(functions.some((fn) => fn.name === "getAuth")).toBe(true);
  for (const fn of functions.filter((fn) => fn.name !== "loadDashboard")) {
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
        },
      );
      expect(denied.status()).toBe(403);
      expect(await denied.text()).not.toContain(token);
    }
  }
  const read = functions.find((fn) => fn.name === "loadDashboard")!;
  const rpc = await context.request.get(`${appUrl}/_serverFn/${read.id}`, {
    headers: { "sec-fetch-site": "same-origin", "x-tsr-serverFn": "true" },
  });
  expect(rpc.status()).toBe(200);
  expect(rpc.headers()["cache-control"]).toContain("no-store");
  const payload = await rpc.text();
  expect(payload).toContain("ready");
  expect(payload).not.toContain(token);
  const beforeRefresh = reads;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(beforeRefresh);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "/tmp/trainer-dashboard.png", fullPage: true });
  expect(output).not.toContain(token);
  expect(output).not.toContain("synthetic-refresh-token");
  // No cookie was shared with the request fixture's independent browser context.
  expect(await (await request.get(appUrl)).text()).not.toContain("79.9");
});

test("sign-in creates a PKCE verifier and an invalid callback fails closed", async ({ request }) => {
  const response = await request.get(`${appUrl}/auth/sign-in`, {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(302);
  expect(response.headers()["location"]).toContain("code_challenge=");
  expect(response.headers()["set-cookie"]).toContain("HttpOnly");
  expect(response.headers()["set-cookie"]).toContain("SameSite=Lax");
  const failed = await request.get(
    `${appUrl}/auth/callback?code=synthetic-invalid&state=wrong`,
    { maxRedirects: 0 },
  );
  expect(failed.status()).toBe(400);
  expect(await failed.text()).toContain("Sign-in failed");
});

test("a completed authorization-code callback creates a session and opens the chart", async ({ context, page }) => {
  const started = await context.request.get(`${appUrl}/auth/sign-in`, {
    maxRedirects: 0,
  });
  const state = new URL(started.headers()["location"]).searchParams.get(
    "state",
  );
  expect(state).toBeTruthy();
  const callback = await context.request.get(
    `${appUrl}/auth/callback?${new URLSearchParams({
      code: "synthetic-code",
      state: state!,
    })}`,
    { maxRedirects: 0 },
  );
  expect(callback.status()).toBe(307);
  expect(callback.headers()["location"]).toBe(`${appUrl}/`);
  const cookie = (await context.cookies()).find((cookie) =>
    cookie.name === "wos-session"
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  await page.goto(appUrl);
  await expect(page.getByRole("heading", { name: "Weight history" }))
    .toBeVisible();
});

test("a proxied sign-in returns to the configured HTTPS address despite forged host headers", async ({ request }) => {
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
      `${publicOrigin}/auth/callback`,
    );
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(started.headers()["set-cookie"]).toContain("Secure");
    // Forward cookies explicitly: this test intentionally sends the backend an
    // HTTP request, not a browser's public HTTPS request. No external host is hit.
    const verifier = started.headersArray()
      .filter(({ name }) => name.toLowerCase() === "set-cookie")
      .map(({ value }) => value.split(";")[0]).join("; ");
    const callback = await request.get(
      `${proxyAppUrl}/auth/callback?${new URLSearchParams({
        code: "synthetic-code",
        state: state!,
      })}`,
      { headers: { ...headers, cookie: verifier }, maxRedirects: 0 },
    );
    expect(callback.status()).toBe(307);
    expect(callback.headers()["location"]).toBe(`${publicOrigin}/`);
    const cookie = callback.headersArray().find(({ name, value }) =>
      name.toLowerCase() === "set-cookie" && value.startsWith("wos-session=")
    )?.value;
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const dashboard = await request.get(proxyAppUrl, {
      headers: { ...headers, cookie: cookie!.split(";")[0] },
    });
    expect(dashboard.status()).toBe(200);
    expect(await dashboard.text()).toContain("Weight history");
    const logout = await request.post(`${proxyAppUrl}/auth/sign-out`, {
      headers: {
        ...headers,
        cookie: cookie!.split(";")[0],
        origin: publicOrigin,
      },
      form: { source: "synthetic-proxy-test" },
      maxRedirects: 0,
    });
    expect(logout.status()).toBe(303);
    expect(logout.headers()["set-cookie"]).toMatch(
      /Max-Age=0|Expires=Thu, 01 Jan 1970/i,
    );
  }
});

test("proxied CSRF checks accept only the public origin, including Origin and Referer fallbacks", async ({ request }) => {
  const read = functions.find((fn) => fn.name === "loadDashboard")!;
  const before = reads;
  const token = await sign();
  const cookie = `wos-session=${
    encodeURIComponent(
      await sessionEncryption.sealData({
        user,
        accessToken: token,
        refreshToken: "synthetic-refresh-token",
      }, { password }),
    )
  }`;
  const cases: Array<{ headers: Record<string, string>; allowed: boolean }> = [
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
    const logout = await request.post(`${proxyAppUrl}/auth/sign-out`, {
      headers: sent,
      maxRedirects: 0,
    });
    expect(logout.status()).toBe(allowed ? 303 : 403);
  }
  expect(reads).toBe(before + cases.filter(({ allowed }) => allowed).length);
});

test("another valid account cannot make an API read", async ({ page, context }) => {
  await session(context, "user_other");
  const before = reads;
  await page.goto(appUrl);
  await expect(page.getByRole("alert")).toContainText(
    "This account cannot open",
  );
  expect(reads).toBe(before);
});

test("expired sessions refresh through the SDK and replace the HttpOnly cookie", async ({ page, context }) => {
  await session(context, user.id, true);
  const before = refreshes;
  await page.goto(appUrl);
  await expect(page.getByRole("heading", { name: "Weight history" }))
    .toBeVisible();
  expect(refreshes).toBeGreaterThan(before);
  const cookie = (await context.cookies()).find((cookie) =>
    cookie.name === "wos-session"
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
});

test("empty records and API failures are distinct, visible states", async ({ page, context }) => {
  await session(context);
  empty = true;
  await page.goto(appUrl);
  await expect(
    page.getByRole("heading", { name: "No weight measurements yet." }),
  ).toBeVisible();
  failure = true;
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "Could not load your record",
  );
  await expect(page.getByRole("alert")).not.toContainText(
    "private upstream detail",
  );
});

test("missing API trends never become an unlabelled raw-only chart", async ({ page, context }) => {
  await session(context);
  missingTrend = true;
  await page.goto(appUrl);
  await expect(
    page.getByRole("heading", {
      name: "No trend is available for this window.",
    }),
  ).toBeVisible();
  await expect(page.locator("svg")).toHaveCount(0);
  await expect(page.getByText("Measurements in this window", { exact: false }))
    .toBeVisible();
});

test("sign-out clears the local session before redirecting to WorkOS", async ({ context }) => {
  await session(context);
  const response = await context.request.post(`${appUrl}/auth/sign-out`, {
    headers: { origin: appUrl },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(response.headers()["set-cookie"]).toMatch(
    /Max-Age=0|Expires=Thu, 01 Jan 1970/i,
  );
  expect(
    (await context.cookies()).some((cookie) =>
      cookie.name === "wos-session" && cookie.value
    ),
  ).toBe(false);
  const html = await (await context.request.get(appUrl)).text();
  expect(html).not.toContain("79.9");
});
