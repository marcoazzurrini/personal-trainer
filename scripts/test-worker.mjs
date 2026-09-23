// Local contract runner. No Wrangler config, persistent DB, .env or provider credentials.
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const args = process.argv.slice(2);
const lifecycleProbe = args.length === 1 && args[0] === "--lifecycle-probe";
if (args.includes("--coverage")) {
  throw new Error(
    "Deno client coverage is not Worker coverage. Use workerd coverage tooling; --coverage is not supported.",
  );
}
// Only selectors are configurable. Never let a short alias or a new Deno flag
// bypass the local-network, cached-dependency or no-subprocess boundary.
const testArgs = [];
if (!lifecycleProbe) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--filter") {
      if (args[i + 1] === undefined) {
        throw new Error("--filter requires a value.");
      }
      testArgs.push(`--filter=${args[++i]}`);
    } else if (/^--filter=/.test(arg) || /^--fail-fast(?:=\d+)?$/.test(arg)) {
      testArgs.push(arg);
    } else if (
      !arg.startsWith("-") &&
      (resolve(arg) === resolve("api/tests") ||
        resolve(arg).startsWith(resolve("api/tests") + "/"))
    ) {
      testArgs.push(arg);
    } else {
      throw new Error(
        "Only API test paths, --filter and --fail-fast are accepted; permission/config overrides are not allowed.",
      );
    }
  }
}
if (!testArgs.some((arg) => !arg.startsWith("-"))) testArgs.push("api/tests/");
const directory = await mkdtemp(join(tmpdir(), "pt-worker-test-"));
// Miniflare also owns signal handlers and may exit before async disposal ends.
// Its exit hook stops workerd; this hook always removes our private receipt.
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const run = randomBytes(32).toString("hex");
const secret = randomBytes(32).toString("hex");
let mf, server, child;
let stopping = false;
let unexpectedOutbound = 0;
const env = {};
for (const key of ["PATH", "HOME", "TMPDIR", "DENO_DIR", "SYSTEMROOT"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
async function stop() {
  if (stopping) return;
  stopping = true;
  child?.kill("SIGTERM");
  if (server) await new Promise((resolve) => server.close(resolve));
  await mf?.dispose();
  await rm(directory, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void stop().then(() => process.exit(1)));
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
      /(?:^|\/)api\/db\.ts$|node_modules\/postgres\//.test(name)
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
      unexpectedOutbound++;
      return Response.json({
        error: "External networking is blocked in contract tests.",
      }, { status: 599 });
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
  const migrations = (await readdir("db/d1/migrations")).filter((f) =>
    f.endsWith(".sql")
  ).sort();
  if (!migrations.length) throw new Error("No D1 migrations found.");
  try {
    parser.exec("PRAGMA foreign_keys=ON");
    for (const name of migrations) {
      let remaining = await readFile(join("db/d1/migrations", name), "utf8");
      const statements = [];
      while (true) {
        remaining = remaining.replace(
          /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/,
          "",
        );
        if (!remaining) break;
        const statement = parser.prepare(remaining);
        const sql = statement.sourceSQL;
        if (!sql || !remaining.startsWith(sql)) {
          throw new Error(`Cannot parse migration ${name}`);
        }
        statement.run();
        statements.push(db.prepare(sql));
        remaining = remaining.slice(sql.length);
      }
      if (statements.length) await db.batch(statements);
    }
  } finally {
    parser.close();
  }
  await db.prepare("CREATE TABLE __test_identity (run TEXT NOT NULL)").run();
  await db.prepare("INSERT INTO __test_identity VALUES (?)").bind(run).run();
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
          }).format(new Date()),
        );
      }
      if (
        body.action !== "batch" || !Array.isArray(body.statements) ||
        !body.statements.length
      ) throw new Error("Expected a nonempty native D1 batch.");
      const statements = body.statements.map(({ sql, params = [] }) => {
        if (
          typeof sql !== "string" || !Array.isArray(params) ||
          params.some((v) =>
            v !== null && typeof v !== "string" && typeof v !== "number"
          )
        ) throw new Error("Invalid native D1 statement.");
        return db.prepare(sql).bind(...params);
      });
      reply(200, await db.batch(statements));
    } catch (error) {
      reply(400, { error: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = await mf.ready;
  const receipt = join(directory, "disposable.json");
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
    `Worker+D1 contract suite: ${migrations.length} migrations; ephemeral binding; outbound networking blocked.`,
  );
  if (lifecycleProbe) {
    console.log(`LIFECYCLE_READY ${origin.origin}`);
    await new Promise(() => {}); // SIGTERM disposes Miniflare and the owned directory.
  }
  child = spawn("deno", [
    "test",
    "--cached-only",
    "--frozen",
    "--allow-net=127.0.0.1",
    "--allow-env",
    "--allow-read",
    ...(testArgs.length ? testArgs : ["api/tests/"]),
  ], {
    cwd: root,
    env: {
      ...env,
      DENO_NO_UPDATE_CHECK: "1",
      DENO_NO_PROMPT: "1",
      TEST_DISPOSABLE_FILE: receipt,
      API_URL: identity.apiUrl,
    },
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (unexpectedOutbound) {
    throw new Error(
      `${unexpectedOutbound} unexpected outbound Worker requests were blocked.`,
    );
  }
  process.exitCode = code;
} finally {
  await stop();
}
