import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import { DB_URL, today, TOKEN, uuid } from "./helpers.ts";
import { handleRequest } from "../index.ts";
import { internalError } from "../shared/errors.ts";

Deno.test("diagnostic IDs correlate safe records without exporting input or internal exceptions", async () => {
  const db = postgres(DB_URL);
  const logs: string[] = [];
  const log = console.log, error = console.error;
  const privateValue = "synthetic-personal-body-path-query-cookie";
  const requestId = uuid();
  try {
    await db`create function test_private_error() returns trigger language plpgsql as $$
      begin raise exception 'synthetic-personal-body-path-query-cookie Authorization: Bearer synthetic-private-token'; end $$`;
    await db`create trigger test_private_error before insert on blocks for each row execute function test_private_error()`;
    console.log = console.error = (...args: unknown[]) =>
      logs.push(args.join(" "));
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await handleRequest(
        new Request("http://localhost/api/api/blocks", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            cookie: privateValue,
            "X-Request-ID": privateValue,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: privateValue,
            goal: "test",
            started_on: today(),
            request_id: requestId,
          }),
        }),
      );
      assertEquals(response.status, 500);
      const body = await response.json();
      assertEquals(Object.keys(body), ["error"]);
      const id = response.headers.get("X-Request-ID")!;
      assert(/^[0-9a-f-]{36}$/.test(id));
      ids.push(id);
      assert(body.error.includes(id));
      assert(body.error.includes("Write outcome is uncertain"));
      assert(body.error.includes("original write request_id"));
      assert(body.error.includes("Reconcile GitHub"));
      const record = JSON.parse(logs.at(-1)!);
      assertEquals(record.diagnostic_id, id);
      assertEquals(record.route, "/api/blocks");
      assertEquals(record.method, "POST");
      assertEquals(record.status, 500);
      assertEquals(record.error, "unexpected");
      assert(record.duration_ms >= 0);
    }
    assert(ids[0] !== ids[1] && !ids.includes(requestId));
    for (
      const path of [
        `/api/foods/${privateValue}`,
        `/api/no-such-route/${privateValue}?q=${privateValue}`,
      ]
    ) {
      const response = await handleRequest(
        new Request("http://localhost" + path, {
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      );
      await response.body?.cancel();
      const record = JSON.parse(logs.at(-1)!);
      assertEquals(
        record.route,
        path.includes("foods") ? "/api/foods/:ref" : "unmatched",
      );
    }
    const webhook = await handleRequest(
      new Request("http://localhost/api/withings/notify", {
        method: "POST",
        body: `appli=${privateValue}`,
      }),
    );
    await webhook.body?.cancel();
    for (
      const sensitive of [
        privateValue,
        "synthetic-private-token",
        TOKEN,
        requestId,
      ]
    ) assert(!logs.join("\n").includes(sensitive));
    assert(
      internalError({ id: "test", route: "/read" }, "GET").includes(
        "Try this read again later",
      ),
    );
  } finally {
    console.log = log;
    console.error = error;
    await db`drop trigger if exists test_private_error on blocks`;
    await db`drop function if exists test_private_error()`;
    await db.end();
    const { sql } = await import("../db.ts");
    await sql.end();
  }
});
