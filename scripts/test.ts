// A fresh cluster per invocation, never the local Compose database or a URL
// inherited from a shell. Own the container ID before running any setup SQL.
import { migrate } from "../db/migrate.ts";
import {
  type Disposable,
  readyApiUrl,
  verifyApi,
  verifyDatabase,
} from "../api/tests/disposable.ts";

const run = crypto.randomUUID().replaceAll("-", "");
const database = `pt_test_${run}`;
const coverage = Deno.args[0] === "--coverage";
const testArgs = coverage ? Deno.args.slice(1) : Deno.args;
const coverageRoot = `${Deno.cwd()}/coverage/${run}`;
let testsStarted = false;
const directory = await Deno.makeTempDir({ prefix: "pt-test-" });
const receipt = `${directory}/disposable.json`;
let containerId: string | undefined;
let api: Deno.ChildProcess | undefined;

// Do not forward provider credentials, database URLs, or .env files to children.
const env: Record<string, string> = {};
for (
  const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "DENO_DIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
  ]
) {
  const value = Deno.env.get(key);
  if (value !== undefined) env[key] = value;
}

async function docker(...args: string[]): Promise<string> {
  const result = await new Deno.Command("docker", {
    args,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `docker ${args[0]} failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

try {
  containerId = await docker(
    "run",
    "--detach",
    "--label",
    `personal-trainer-test=${run}`,
    "--publish",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--env",
    `POSTGRES_DB=${database}`,
    "--env",
    `POSTGRES_PASSWORD=${run}`,
    "postgres:17-alpine",
  );
  const [container] = JSON.parse(await docker("inspect", containerId));
  if (
    container.Id !== containerId ||
    container.Config.Labels["personal-trainer-test"] !== run ||
    container.HostConfig.Tmpfs["/var/lib/postgresql/data"] === undefined
  ) throw new Error("New test container ownership could not be verified.");
  const port = container.NetworkSettings.Ports["5432/tcp"][0];
  if (port.HostIp !== "127.0.0.1") {
    throw new Error("Test Postgres must bind loopback.");
  }
  let ready = false;
  for (let i = 0; i < 60; i++) {
    // TCP excludes the image's temporary socket-only initialization server.
    // A not-yet-ready database is expected; Docker/runtime failures are not.
    const status = await docker(
      "exec",
      containerId,
      "sh",
      "-c",
      "pg_isready -h 127.0.0.1 -U postgres >/dev/null; echo $?",
    );
    if (status === "0") {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) {
    throw new Error("Disposable Postgres did not become ready in 30s.");
  }
  // Read identity through the owned container, not through the supplied URL.
  const systemId = await docker(
    "exec",
    containerId,
    "psql",
    "-U",
    "postgres",
    "-d",
    database,
    "-Atc",
    "select system_identifier::text from pg_control_system()",
  );
  const d: Disposable = {
    kind: "personal-trainer-disposable-v1",
    containerId,
    systemId,
    database,
    databaseUrl:
      `postgresql://postgres:${run}@127.0.0.1:${port.HostPort}/${database}`,
    apiUrl: "http://127.0.0.1:0/api",
  };
  await Deno.writeTextFile(receipt, JSON.stringify(d), { mode: 0o600 });
  await verifyDatabase(d, d.databaseUrl);
  console.log(
    `Disposable container ${containerId}; cluster ${systemId}; database ${database}`,
  );
  const report = await migrate(d.databaseUrl);
  console.log(
    `Applied ${report.ran.length} migrations after identity verification.`,
  );
  const childEnv = {
    ...env,
    TEST_DISPOSABLE_FILE: receipt,
    DATABASE_URL: d.databaseUrl,
    TEST_DATABASE_URL: d.databaseUrl,
    AUTH_ISSUER: "http://127.0.0.1:1",
    ALLOWED_SUBJECT: "user_test",
  };
  api = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      ...(coverage ? [`--coverage=${coverageRoot}/api`] : []),
      "--allow-net=127.0.0.1",
      "--allow-env",
      "--allow-read",
      `--allow-write=${receipt}.ready`,
      "api/tests/serve.ts",
    ],
    env: childEnv,
    clearEnv: true,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const url = readyApiUrl(await Deno.readTextFile(`${receipt}.ready`));
      if (url !== undefined) {
        d.apiUrl = url;
        ready = true;
        break;
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("Disposable API did not become ready in 30s.");
  await Deno.writeTextFile(receipt, JSON.stringify(d), { mode: 0o600 });
  await verifyApi(d);
  console.log(
    `API ${d.apiUrl} verified against the same cluster and database.`,
  );
  testsStarted = true;
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      ...(coverage
        ? [`--coverage=${coverageRoot}/tests`, "--coverage-raw-data-only"]
        : []),
      "--allow-net=127.0.0.1,0.0.0.0",
      "--allow-env",
      "--allow-read",
      ...(testArgs.length ? testArgs : ["api/tests/"]),
    ],
    env: { ...childEnv, API_URL: d.apiUrl },
    clearEnv: true,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!result.success) throw new Error(`Tests failed (exit ${result.code}).`);
} finally {
  try {
    await stopApi();
    if (coverage && testsStarted) await reportCoverage();
  } finally {
    if (containerId) {
      await docker("rm", "--force", "--volumes", containerId);
      console.log(`Removed disposable container ${containerId} and its state.`);
    }
    await Deno.remove(directory, { recursive: true });
  }
}

async function reportCoverage(): Promise<void> {
  // This directory belongs only to the HTTP server, never the test process.
  // Import coverage alone is insufficient: the handler must actually execute.
  let handledHttp = false;
  const loadedApi = new Set<string>();
  for (const scope of ["api", "tests"]) {
    for await (const entry of Deno.readDir(`${coverageRoot}/${scope}`)) {
      if (!entry.name.endsWith(".json")) continue;
      const profile = JSON.parse(
        await Deno.readTextFile(`${coverageRoot}/${scope}/${entry.name}`),
      );
      if (
        profile.url.startsWith(new URL("../api/", import.meta.url).href) &&
        !profile.url.startsWith(new URL("../api/tests/", import.meta.url).href)
      ) {
        loadedApi.add(scope);
      }
      if (scope !== "api" || !profile.url.endsWith("/api/index.ts")) continue;
      handledHttp ||= profile.functions.some((
        fn: { functionName: string; ranges: { count: number }[] },
      ) =>
        fn.functionName === "handleRequest" &&
        fn.ranges.some((range) => range.count > 0)
      );
    }
  }
  if (!handledHttp) {
    throw new Error(
      "API coverage did not record an HTTP handler call; client coverage is not API coverage.",
    );
  }
  for (const scope of ["api", "tests", "combined"]) {
    if (scope !== "combined" && !loadedApi.has(scope)) {
      const report =
        `Coverage scope: ${scope}: no API source loaded by this process.\n`;
      await Deno.writeTextFile(`${coverageRoot}/${scope}.txt`, report);
      console.log(report);
      continue;
    }
    const paths = scope === "combined"
      ? [`${coverageRoot}/api`, `${coverageRoot}/tests`]
      : [`${coverageRoot}/${scope}`];
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "coverage",
        "--include=.*/api/.*",
        "--exclude=.*/api/tests/.*",
        ...paths,
      ],
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(`Coverage report failed for ${scope}.`);
    }
    const report = new TextDecoder().decode(result.stdout);
    await Deno.writeTextFile(`${coverageRoot}/${scope}.txt`, report);
    console.log(`Coverage scope: ${scope} (API source only)\n${report}`);
  }
  console.log(`Coverage profiles and labeled reports: ${coverageRoot}`);
}

async function stopApi(): Promise<void> {
  if (!api) return;
  try {
    api.kill("SIGTERM");
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const timer = setTimeout(() => {
    try {
      api?.kill("SIGKILL");
    } catch { /* already exited */ }
  }, 10_000);
  try {
    const status = await api.status;
    if (!status.success) {
      throw new Error(
        `Disposable API did not drain cleanly (exit ${status.code}).`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
