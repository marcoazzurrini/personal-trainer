import { test } from "node:test";

import { handleRequest } from "../index.ts";
import { internalError } from "../shared/errors.ts";
import { assert, assertEquals } from "./assertions.ts";
import d1, { database } from "./d1.ts";
import { today, TOKEN, uuid } from "./helpers.ts";

test("diagnostic IDs correlate safe records without exporting input or internal exceptions", async () => {
  const db = d1();
  const request = (req: Request) =>
    handleRequest(
      req,
      { DB: database, ALLOWED_SUBJECT: "user_test" },
      {
        waitUntil() {
          /* These diagnostic probes schedule no background work. */
        },
        passThroughOnException() {
          /* No upstream service exists in this harness. */
        },
      }
    );
  const logs: string[] = [];
  const { log, error } = console;
  const privateValue = "synthetic-personal-body-path-query-cookie";
  const requestId = uuid();
  try {
    await db`CREATE TRIGGER test_private_error BEFORE INSERT ON blocks
      BEGIN SELECT RAISE(ABORT, 'synthetic-personal-body-path-query-cookie Authorization: Bearer synthetic-private-token'); END`;
    const capture: typeof console.log = (...args) => {
      logs.push(args.join(" "));
    };
    console.log = capture;
    console.error = capture;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await request(
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
        })
      );
      assertEquals(response.status, 500);
      const body = await response.json();
      assertEquals(Object.keys(body), ["error"]);
      const id = response.headers.get("X-Request-ID");
      assert(id !== null);
      assert(/^[0-9a-f-]{36}$/u.test(id));
      ids.push(id);
      assert(body.error.includes(id));
      assert(body.error.includes("Write outcome is uncertain"));
      assert(body.error.includes("original write request_id"));
      assert(body.error.includes("Reconcile GitHub"));
      const lastLog = logs.at(-1);
      assert(lastLog !== undefined);
      const record = JSON.parse(lastLog);
      assertEquals(record.diagnostic_id, id);
      assertEquals(record.route, "/api/blocks");
      assertEquals(record.method, "POST");
      assertEquals(record.status, 500);
      assertEquals(record.error, "unexpected");
      assert(record.duration_ms >= 0);
    }
    assert(ids[0] !== ids[1] && !ids.includes(requestId));
    for (const path of [
      `/api/foods/${privateValue}`,
      `/api/no-such-route/${privateValue}?q=${privateValue}`,
    ]) {
      const response = await request(
        new Request(`http://localhost${path}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      );
      await response.body?.cancel();
      const lastLog = logs.at(-1);
      assert(lastLog !== undefined);
      const record = JSON.parse(lastLog);
      assertEquals(
        record.route,
        path.includes("foods") ? "/api/foods/:ref" : "unmatched"
      );
    }
    const webhook = await request(
      new Request("http://localhost/api/withings/notify", {
        method: "POST",
        body: `appli=${privateValue}`,
      })
    );
    await webhook.body?.cancel();
    for (const sensitive of [
      privateValue,
      "synthetic-private-token",
      TOKEN,
      requestId,
    ]) {
      assert(!logs.join("\n").includes(sensitive));
    }
    assert(
      internalError({ id: "test", route: "/read" }, "GET").includes(
        "Try this read again later"
      )
    );
  } finally {
    console.log = log;
    console.error = error;
    await db`drop trigger if exists test_private_error`;
    await db.end();
  }
});
