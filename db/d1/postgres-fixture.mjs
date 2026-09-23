import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";

// Own a NEW local Docker container before running SQL. Never read .env, inherit
// DATABASE_URL, reuse Compose, or accept an existing PostgreSQL endpoint.
export async function disposablePostgres() {
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR"].filter((key) => process.env[key]).map((
      key,
    ) => [key, process.env[key]]),
  );
  function invoke(args) {
    const result = spawnSync("docker", args, {
      env,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`Disposable Docker command ${args[0]} failed.`);
    }
    return result.stdout.trim();
  }
  const host = invoke([
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ]);
  if (!host.startsWith("unix://")) {
    throw new Error(
      "PostgreSQL migration tests require a local Unix-socket Docker context.",
    );
  }
  const docker = (...args) => invoke(["--host", host, ...args]);
  const run = randomUUID().replaceAll("-", "");
  const id = docker(
    "run",
    "--detach",
    "--label",
    `personal-trainer-d1-test=${run}`,
    "--publish",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--env",
    `POSTGRES_PASSWORD=${run}`,
    "--env",
    `POSTGRES_DB=pt_test_${run}`,
    "postgres:17-alpine",
  );
  let sql;
  try {
    const [container] = JSON.parse(docker("inspect", id));
    if (
      container.Id !== id ||
      container.Config.Labels["personal-trainer-d1-test"] !== run ||
      container.HostConfig.Tmpfs["/var/lib/postgresql/data"] === undefined
    ) {
      throw new Error(
        "Cannot verify ownership of the disposable PostgreSQL container.",
      );
    }
    const port = container.NetworkSettings.Ports["5432/tcp"][0];
    if (port.HostIp !== "127.0.0.1") {
      throw new Error("Disposable PostgreSQL must bind loopback.");
    }
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (
        docker(
          "exec",
          id,
          "sh",
          "-c",
          "pg_isready -h 127.0.0.1 -U postgres >/dev/null; echo $?",
        ) === "0"
      ) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error("Disposable PostgreSQL did not become ready.");
    const url =
      `postgresql://postgres:${run}@127.0.0.1:${port.HostPort}/pt_test_${run}`;
    sql = postgres(url, { max: 1, onnotice() {} });
    await sql`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const files = (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => name.endsWith(".sql")).sort();
    for (const file of files) {
      const source = await readFile(
        new URL(`../migrations/${file}`, import.meta.url),
        "utf8",
      );
      await sql.begin(async (tx) => {
        await tx.unsafe(source);
        await tx`INSERT INTO schema_migrations (version) VALUES (${
          file.slice(0, -4)
        })`;
      });
    }
    return {
      sql,
      url,
      async dispose() {
        try {
          await sql.end({ timeout: 5 });
        } finally {
          docker("rm", "--force", "--volumes", id);
        }
      },
    };
  } catch (error) {
    try {
      await sql?.end({ timeout: 5 });
    } finally {
      docker("rm", "--force", "--volumes", id);
    }
    throw error;
  }
}
