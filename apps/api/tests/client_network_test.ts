import { test } from "node:test";

import { assertEquals, assertRejects } from "./assertions.ts";

test("API clients receive no provider or database credentials", () => {
  for (const name of [
    "DATABASE_URL",
    "TEST_DATABASE_URL",
    "GITHUB_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "WITHINGS_CLIENT_SECRET",
    "WORKOS_API_KEY",
  ]) {
    assertEquals(
      process.env[name],
      undefined,
      `${name} must not enter the test client.`
    );
  }
});

test("API clients cannot fetch external providers or follow redirects to them", async () => {
  await assertRejects(
    () => fetch("https://example.com/"),
    Error,
    "owned 127.0.0.1"
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.redirect("https://example.com/", 302),
  });
  try {
    await assertRejects(() => fetch(server.url), Error);
    const manual = await fetch(server.url, { redirect: "manual" });
    assertEquals(manual.status, 302);
    await manual.body?.cancel();
  } finally {
    await server.stop(true);
  }
});
