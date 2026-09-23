import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  parseOptions,
  seed,
  seedSql,
  wranglerCommand,
} from "./seed_withings.ts";

const tokens = {
  accessToken: "synthetic-access-'quote",
  refreshToken: "synthetic-refresh",
  expiresAt: "2026-09-17T12:00:00.000Z",
};

Deno.test("Withings seeding requires an explicit target, private file and paused writers", () => {
  for (
    const args of [[], ["--local"], ["--secrets", "file"], [
      "--local",
      "--secrets",
      "file",
    ], ["--local", "--remote", "--secrets", "file", "--writers-paused"]]
  ) {
    assertThrows(() => parseOptions(args));
  }
  assertEquals(
    parseOptions([
      "--remote",
      "--secrets",
      "file",
      "--writers-paused",
      "--recover",
    ]),
    {
      target: "remote",
      secrets: "file",
      recover: true,
    },
  );
});

Deno.test("Withings seed SQL escapes tokens and resets both catch-up checkpoints", () => {
  const sql = seedSql(
    "synthetic-user",
    tokens,
    new Date("2026-09-17T09:00:00Z"),
  );
  assert(sql.includes("synthetic-access-''quote"));
  assert(sql.includes("2026-09-17T12:00:00.000000Z"));
  assert(sql.includes("last_sync_at = NULL, last_sync_attempt_at = NULL"));
  assert(!sql.includes("DELETE"));
});

Deno.test("Withings command uses installed Wrangler and keeps SQL out of arguments", () => {
  const command = wranglerCommand("remote", "/private/seed.sql", "/private");
  assert(command.args?.includes("--remote"));
  assert(command.args?.includes("--file"));
  assert(!command.args?.includes("--command"));
  assertEquals(command.env?.WRANGLER_WRITE_LOGS, "false");
  assertEquals(command.env?.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, "false");
});

async function secretsFixture(): Promise<{ dir: string; path: string }> {
  const dir = await Deno.makeTempDir({ prefix: "pt-withings-fixture-" });
  const path = `${dir}/secrets.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      WITHINGS_CLIENT_ID: "synthetic-client",
      WITHINGS_CLIENT_SECRET: "synthetic-secret",
      WITHINGS_USER_ID: "synthetic-user",
      WITHINGS_REFRESH_TOKEN: "synthetic-old-refresh",
    }),
    { mode: 0o600 },
  );
  return { dir, path };
}

Deno.test("Withings preflight failure cannot consume a provider refresh token", async () => {
  const fixture = await secretsFixture();
  let refreshes = 0;
  let workspace = "";
  try {
    await assertRejects(
      () =>
        seed({ target: "local", secrets: fixture.path, recover: false }, {
          execute: (_target, _sql, dir) => {
            workspace = dir;
            return Promise.reject(new Error("synthetic private SQL details"));
          },
          refresh: () => {
            refreshes++;
            return Promise.resolve(tokens);
          },
        }),
      Error,
      "Preflight failed; no provider refresh was attempted.",
    );
    assertEquals(refreshes, 0);
    await assertRejects(() => Deno.stat(workspace), Deno.errors.NotFound);
  } finally {
    await Deno.remove(fixture.dir, { recursive: true });
  }
});

Deno.test("Withings failed save preserves private returned tokens and recovery never refreshes twice", async () => {
  const fixture = await secretsFixture();
  let workspace = "";
  let refreshes = 0;
  let writes = 0;
  try {
    await assertRejects(
      () =>
        seed({ target: "local", secrets: fixture.path, recover: false }, {
          execute: (_target, _sql, dir) => {
            workspace = dir;
            if (++writes === 1) return Promise.resolve([]);
            return Promise.reject(new Error("synthetic private SQL details"));
          },
          refresh: () => {
            refreshes++;
            return Promise.resolve(tokens);
          },
        }),
      Error,
      "D1 save failed or its outcome is uncertain.",
    );
    assertEquals(refreshes, 1);
    const receiptPath = `${workspace}/receipt.json`;
    assertEquals((await Deno.stat(receiptPath)).mode! & 0o077, 0);
    assertEquals(
      JSON.parse(await Deno.readTextFile(receiptPath)).tokens,
      tokens,
    );
    const recovery = {
      target: "local" as const,
      secrets: receiptPath,
      recover: true,
    };
    await assertRejects(
      () =>
        seed({ ...recovery, target: "remote" }, {
          execute: () => {
            throw new Error("Must not open a mismatched destination.");
          },
        }),
      Error,
      "Receipt does not match the explicit target",
    );
    const sql: string[] = [];
    let recoveredWorkspace = "";
    await seed(recovery, {
      execute: (_target, statement, dir) => {
        sql.push(statement);
        recoveredWorkspace = dir;
        return Promise.resolve([]);
      },
      refresh: () => {
        refreshes++;
        throw new Error("Recovery must not refresh.");
      },
    });
    assertEquals(refreshes, 1);
    assertEquals(sql.length, 2);
    assert(sql[1].includes("synthetic-access-''quote"));
    await assertRejects(
      () => Deno.stat(recoveredWorkspace),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(fixture.dir, { recursive: true });
    if (workspace) {
      await Deno.remove(workspace, { recursive: true }).catch(() => {});
    }
  }
});

Deno.test("Withings seeding rejects group-readable credentials before accessing D1", async () => {
  const fixture = await secretsFixture();
  try {
    await Deno.chmod(fixture.path, 0o640);
    await assertRejects(
      () =>
        seed({ target: "local", secrets: fixture.path, recover: false }, {
          execute: () => {
            throw new Error("Must not access D1.");
          },
        }),
      Error,
      "Cannot read secret file",
    );
  } finally {
    await Deno.remove(fixture.dir, { recursive: true });
  }
});
