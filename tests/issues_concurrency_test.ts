import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import { DB_URL, uuid } from "./helpers.ts";

Deno.test("independent API instances serialize one GitHub create but not unrelated IDs", async () => {
  const db = postgres(DB_URL);
  let hits = 0;
  let fail = false;
  let gate = Promise.withResolvers<void>();
  let entered = Promise.withResolvers<void>();
  const stub = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      await req.json();
      const number = ++hits;
      entered.resolve();
      await gate.promise;
      return fail
        ? Response.json({ message: "offline" }, { status: 503 })
        : Response.json({
          number,
          html_url: `https://example.invalid/issues/${number}`,
        }, { status: 201 });
    },
  );
  const workers: Worker[] = [];
  const pending: Promise<unknown>[] = [];
  function call(id: string) {
    const worker = new Worker(
      new URL("./issues_worker.ts", import.meta.url).href,
      { type: "module" },
    );
    workers.push(worker);
    const result = new Promise<
      { status: number; body: { issue: { number: number } } }
    >((resolve, reject) => {
      worker.onmessage = (event) =>
        event.data.failed
          ? reject(new Error("Disposable issue worker failed"))
          : resolve(event.data);
      worker.onerror = () =>
        reject(new Error("Disposable issue worker failed"));
    });
    pending.push(result);
    worker.postMessage({
      stub: `http://127.0.0.1:${stub.addr.port}`,
      body: {
        request_id: id,
        title: "Synthetic race",
        kind: "bug",
        problem: "Synthetic overlap",
        evidence: "Local stub only",
      },
    });
    return result;
  }
  try {
    const id = uuid();
    const first = call(id);
    await entered.promise;
    const second = call(id);
    const end = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < end) {
      const rows =
        await db`select pid from pg_stat_activity where datname = current_database() and wait_event = 'advisory'`;
      if (rows.length) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(
      blocked,
      "Second independent API instance must wait on the database lock.",
    );
    assertEquals(hits, 1);
    // A different ID reaches GitHub while the original is still blocked there.
    entered = Promise.withResolvers<void>();
    const different = call(uuid());
    await entered.promise;
    assertEquals(hits, 2);
    gate.resolve();
    const [a, b, c] = await Promise.all([first, second, different]);
    assertEquals([a.status, b.status, c.status], [201, 200, 201]);
    assertEquals(a.body, b.body);
    assertEquals(hits, 2);
    assertEquals(
      (await db`select * from coach_issues where request_id = ${id}`).length,
      1,
    );

    gate = Promise.withResolvers<void>();
    gate.resolve();
    fail = true;
    const failedId = uuid();
    assertEquals((await call(failedId)).status, 502);
    assertEquals(
      (await db`select * from coach_issues where request_id = ${failedId}`)
        .length,
      0,
    );
    fail = false;
    assertEquals((await call(failedId)).status, 201);
  } finally {
    gate.resolve();
    await Promise.allSettled(pending);
    for (const worker of workers) worker.terminate();
    await stub.shutdown();
    await db.end();
  }
});
