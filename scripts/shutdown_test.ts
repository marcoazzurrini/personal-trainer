import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import { verifiedDatabase } from "../tests/disposable.ts";

Deno.test("the production container/task entrypoint drains and bounds SIGTERM", async (t) => {
  const d = await verifiedDatabase();
  const db = postgres(d.databaseUrl);
  const gate = await db.reserve();
  const run = crypto.randomUUID();
  const image = `personal-trainer-shutdown:${run}`;
  const network = `pt-shutdown-${run}`;
  const containers: string[] = [];
  const requests: Promise<Response | null>[] = [];
  const token = "shutdown-test-token";
  let connected = false, built = false, networkCreated = false;
  async function docker(...args: string[]) {
    const result = await new Deno.Command("docker", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(`Docker ${args[0]} failed; output withheld.`);
    }
    return (new TextDecoder().decode(result.stdout) +
      (args[0] === "logs" ? new TextDecoder().decode(result.stderr) : ""))
      .trim();
  }
  async function until(
    check: () => Promise<boolean>,
    message: string,
    ms = 15000,
  ) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(message);
  }
  async function launch(databaseUrl?: string) {
    const url = new URL(d.databaseUrl);
    url.hostname = "test-db";
    url.port = "5432";
    const id = await docker(
      "run",
      "--detach",
      "--stop-timeout",
      "10",
      "--network",
      network,
      "--label",
      `personal-trainer-test=${run}`,
      "--publish",
      "127.0.0.1::8000",
      "--env",
      `DATABASE_URL=${databaseUrl ?? url.href}`,
      "--env",
      `API_TOKEN=${token}`,
      image,
    );
    containers.push(id);
    const [info] = JSON.parse(await docker("inspect", id));
    assertEquals(info.Config.Labels["personal-trainer-test"], run);
    const base = `http://127.0.0.1:${
      info.NetworkSettings.Ports["8000/tcp"]?.[0]?.HostPort ?? 0
    }/api`;
    return { id, base };
  }
  async function stopped(id: string) {
    await until(
      async () =>
        (await docker("inspect", "--format", "{{.State.Running}}", id)) ===
          "false",
      "Container exceeded its stop budget",
      11000,
    );
    return Number(
      await docker("inspect", "--format", "{{.State.ExitCode}}", id),
    );
  }
  async function blocked(fragment: string) {
    await until(async () => {
      const rows =
        await db`select pid from pg_stat_activity where datname = current_database()
        and wait_event = 'advisory' and query like ${`%${fragment}%`}`;
      return rows.length > 0;
    }, "Controlled SQL operation did not reach its lock");
  }
  try {
    await docker("build", "-t", image, ".");
    built = true;
    await docker("network", "create", network);
    networkCreated = true;
    await docker(
      "network",
      "connect",
      "--alias",
      "test-db",
      network,
      d.containerId,
    );
    connected = true;
    await db`create function test_shutdown_gate() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(9060); return new; end $$`;
    await db`create trigger test_shutdown_gate before insert on blocks for each row execute function test_shutdown_gate()`;
    for (const stuck of [false, true]) {
      await t.step(
        stuck
          ? "a stuck request exits within the drain budget"
          : "accepted work finishes before pool closure; new work stops",
        async () => {
          const { id, base } = await launch();
          await until(async () => {
            try {
              const r = await fetch(`${base}/health`, {
                signal: AbortSignal.timeout(1000),
              });
              await r.body?.cancel();
              return r.ok;
            } catch {
              return false;
            }
          }, "Production entrypoint never became ready");
          await gate`select pg_advisory_lock(9060)`;
          const name = `shutdown-${uuid()}`;
          const pending = fetch(`${base}/blocks`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              request_id: uuid(),
              name,
              goal: "synthetic",
              started_on: "2026-01-01",
            }),
          }).catch(() => null);
          requests.push(pending);
          await blocked("insert into blocks");
          const started = performance.now();
          await docker("kill", "--signal=SIGTERM", id);
          await until(
            async () =>
              (await docker("logs", id)).includes("shutdown: draining"),
            "SIGTERM did not reach the HTTP process",
          );
          if (!stuck) {
            let refused = false;
            try {
              const r = await fetch(`${base}/health`, {
                headers: { connection: "close" },
                signal: AbortSignal.timeout(1000),
              });
              await r.body?.cancel();
            } catch {
              refused = true;
            }
            assert(refused, "Shutdown must stop accepting new work.");
            await gate`select pg_advisory_unlock(9060)`;
            const response = await pending;
            assertEquals(response?.status, 201);
            await response?.body?.cancel();
            assertEquals(await stopped(id), 0);
            assert(
              (await docker("logs", id)).includes(
                "shutdown: drained; database pool closed",
              ),
            );
            assertEquals(
              (await db`select id from blocks where name = ${name}`).length,
              1,
            );
          } else {
            assertEquals(await stopped(id), 1);
            assert(performance.now() - started < 10500);
            assert(
              (await docker("logs", id)).includes("drain deadline exceeded"),
            );
            await gate`select pg_advisory_unlock(9060)`;
            await (await pending)?.body?.cancel();
          }
        },
      );
    }
    await t.step(
      "termination during migration does not start HTTP afterwards",
      async () => {
        await gate`select pg_advisory_lock(hashtext('schema_migrations'))`;
        const { id } = await launch();
        await blocked("pg_advisory_lock(hashtext");
        await docker("kill", "--signal=SIGTERM", id);
        const code = await stopped(id);
        assert(code !== 0);
        await gate`select pg_advisory_unlock(hashtext('schema_migrations'))`;
        const logs = await docker("logs", id);
        assert(!logs.includes("shutdown: drained"));
        assert(!logs.includes("Listening on"));
      },
    );
    await t.step("startup errors fail without credential output", async () => {
      const secret = "synthetic-private-startup-secret";
      const { id } = await launch(
        `postgresql://fixture:${secret}@127.0.0.1:1/missing`,
      );
      assert((await stopped(id)) !== 0);
      const logs = await docker("logs", id);
      assert(!logs.includes(secret));
      assert(!logs.includes("shutdown: drained"));
    });
  } finally {
    await gate`select pg_advisory_unlock_all()`;
    gate.release();
    for (const id of containers) await docker("rm", "--force", "--volumes", id);
    await Promise.allSettled(
      requests.map(async (r) => (await r)?.body?.cancel()),
    );
    await db`drop trigger if exists test_shutdown_gate on blocks`;
    await db`drop function if exists test_shutdown_gate()`;
    await db.end();
    if (connected) {
      await docker("network", "disconnect", network, d.containerId);
    }
    if (networkCreated) await docker("network", "rm", network);
    if (built) await docker("image", "rm", image);
  }
});

function uuid() {
  return crypto.randomUUID();
}
