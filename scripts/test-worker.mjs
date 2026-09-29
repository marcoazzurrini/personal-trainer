import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { z } from "@hono/zod-openapi";
// Local contract runner. No Wrangler config, persistent DB, .env or provider credentials.
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const args = process.argv.slice(2);
const lifecycleProbe = args.length === 1 && args[0] === "--lifecycle-probe";
if (args.includes("--coverage")) {
  throw new Error(
    "Bun client coverage is not Worker coverage. Use workerd coverage tooling; --coverage is not supported."
  );
}
// Only selectors are configurable. Callers cannot change preloads, environment
// loading or the disposable database. Bun is not a process-level sandbox.
const testArgs = [];
if (!lifecycleProbe) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--filter") {
      if (args[i + 1] === undefined) {
        throw new Error("--filter requires a value.");
      }
      i += 1;
      testArgs.push(`--test-name-pattern=${args[i]}`);
    } else if (arg.startsWith("--filter=")) {
      testArgs.push(arg.replace("--filter=", "--test-name-pattern="));
    } else if (/^--fail-fast(?:=\d+)?$/u.test(arg)) {
      testArgs.push(arg.replace("--fail-fast", "--bail"));
    } else if (
      !arg.startsWith("-") &&
      (nodePath.resolve(arg) === nodePath.resolve("api/tests") ||
        nodePath.resolve(arg).startsWith(`${nodePath.resolve("api/tests")}/`))
    ) {
      testArgs.push(nodePath.resolve(arg));
    } else {
      throw new Error(
        "Only API test paths, --filter and --fail-fast are accepted; runner/config overrides are not allowed."
      );
    }
  }
}
if (!testArgs.some((arg) => !arg.startsWith("-"))) {
  testArgs.push(nodePath.resolve("api/tests/"));
}
const directory = await mkdtemp(nodePath.join(tmpdir(), "pt-worker-test-"));
// Miniflare also owns signal handlers and may exit before async disposal ends.
// Its exit hook stops workerd; this hook always removes our private receipt.
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const run = randomBytes(32).toString("hex");
const secret = randomBytes(32).toString("hex");
let child;
let mf;
let server;
let stopping = false;
let unexpectedOutbound = 0;
const env = {};
for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]) {
  if (process.env[key] !== undefined) {
    env[key] = process.env[key];
  }
}
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  child?.kill("SIGTERM");
  if (server) {
    const closed = Promise.withResolvers();
    server.close(closed.resolve);
    await closed.promise;
  }
  await mf?.dispose();
  await rm(directory, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await stop();
    process.exit(1);
  });
}
try {
  const bundle = await build({
    entryPoints: ["api/tests/serve.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
  });
  if (
    Object.keys(bundle.metafile.inputs).some((name) =>
      /(?:^|\/)api\/db\.ts$|node_modules\/postgres\//u.test(name)
    )
  ) {
    throw new Error("Worker contract bundle must not include PostgreSQL.");
  }
  const options = convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-11",
    compatibilityFlags: ["nodejs_compat"],
    host: "127.0.0.1",
    port: 0,
    d1Databases: { DB: `test-${run}` },
    d1Persist: false,
    bindings: {
      TEST_SECRET: secret,
      TEST_RUN: run,
      ALLOWED_SUBJECT: "user_test",
      AUTH_ISSUER: "https://synthetic.invalid",
      PUBLIC_ORIGIN: "https://synthetic.invalid",
    },
    outboundService() {
      unexpectedOutbound += 1;
      return Response.json(
        {
          error: "External networking is blocked in contract tests.",
        },
        { status: 599 }
      );
    },
  });
  if (options.resourcePersistencePath !== undefined) {
    throw new Error("Contract D1 must be ephemeral.");
  }
  mf = new Miniflare({ ...options, cf: false, telemetry: { enabled: false } });
  const db = await mf.getD1Database("DB");
  // SQLite determines exact boundaries, including trigger bodies. Execute every
  // migration in sorted order on D1; the temporary parser never supplies test results.
  const parser = new DatabaseSync(":memory:");
  const migrations = (await readdir("db/d1/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .toSorted();
  if (!migrations.length) {
    throw new Error("No D1 migrations found.");
  }
  try {
    parser.exec("PRAGMA foreign_keys=ON");
    for (const name of migrations) {
      let remaining = await readFile(
        nodePath.join("db/d1/migrations", name),
        "utf-8"
      );
      const statements = [];
      while (true) {
        remaining = remaining.replace(
          /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u,
          ""
        );
        if (!remaining) {
          break;
        }
        const statement = parser.prepare(remaining);
        const sql = statement.sourceSQL;
        if (!sql || !remaining.startsWith(sql)) {
          throw new Error(`Cannot parse migration ${name}`);
        }
        statement.run();
        statements.push(db.prepare(sql));
        remaining = remaining.slice(sql.length);
      }
      if (statements.length) {
        await db.batch(statements);
      }
    }
  } finally {
    parser.close();
  }
  await db.prepare("CREATE TABLE __test_identity (run TEXT NOT NULL)").run();
  await db.prepare("INSERT INTO __test_identity VALUES (?)").bind(run).run();
  const nativeStatement = z.object({
    sql: z.string(),
    params: z.array(z.union([z.string(), z.number(), z.null()])).default([]),
  });
  server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const reply = (status, value) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${secret}`) {
      return reply(403, { error: "Test capability required." });
    }
    if (req.method !== "POST" || req.url !== "/manage") {
      return reply(404, { error: "Unknown test operation." });
    }
    try {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 4 * 1024 * 1024) {
          throw new Error("Fixture exceeds management body limit.");
        }
      }
      const body = JSON.parse(text);
      if (body.run !== run) {
        return reply(403, { error: "Test identity mismatch." });
      }
      if (body.action === "identity") {
        return reply(200, { kind: "personal-trainer-worker-d1-v1", run });
      }
      if (body.action === "today") {
        return reply(
          200,
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Rome",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date())
        );
      }
      if (
        body.action !== "batch" ||
        !Array.isArray(body.statements) ||
        !body.statements.length
      ) {
        throw new Error("Expected a nonempty native D1 batch.");
      }
      const statements = body.statements.map((raw) => {
        const { sql, params } = nativeStatement.parse(raw);
        return db.prepare(sql).bind(...params);
      });
      reply(200, await db.batch(statements));
    } catch (error) {
      reply(400, { error: error.message });
    }
  });
  const listening = Promise.withResolvers();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const origin = await mf.ready;
  const receipt = nodePath.join(directory, "disposable.json");
  const identity = {
    kind: "personal-trainer-worker-d1-v1",
    run,
    secret,
    apiUrl: `${origin.origin}/api`,
    managementUrl: `http://127.0.0.1:${server.address().port}/manage`,
  };
  await writeFile(receipt, JSON.stringify(identity), { mode: 0o600 });
  const proof = await mf.dispatchFetch(`${identity.apiUrl}/__test_identity`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!proof.ok || (await proof.json()).run !== run) {
    throw new Error("Worker is not using the owned D1 binding.");
  }
  console.log(
    `Worker+D1 contract suite: ${migrations.length} migrations; ephemeral binding; outbound networking blocked.`
  );
  if (lifecycleProbe) {
    console.log(`LIFECYCLE_READY ${origin.origin}`);
    // The lifecycle probe waits for SIGTERM to dispose Miniflare and this directory.
    await Promise.withResolvers().promise;
  }
  child = spawn(
    process.execPath,
    [
      "--no-env-file",
      "test",
      "--timeout=120000",
      "--preload=./api/tests/preload.ts",
      ...testArgs,
    ],
    {
      cwd: root,
      env: {
        ...env,
        TEST_DISPOSABLE_FILE: receipt,
        API_URL: identity.apiUrl,
      },
      stdio: "inherit",
    }
  );
  const exited = Promise.withResolvers();
  child.once("error", exited.reject);
  child.once("exit", (exitCode) => exited.resolve(exitCode ?? 1));
  const code = await exited.promise;
  if (unexpectedOutbound) {
    throw new Error(
      `${unexpectedOutbound} unexpected outbound Worker requests were blocked.`
    );
  }
  process.exitCode = code;
} finally {
  await stop();
}
