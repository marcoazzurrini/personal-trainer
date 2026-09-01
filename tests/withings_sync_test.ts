import { assert, assertEquals, assertStringIncludes } from "@std/assert";

// The sync wiring: what happens to a reading between arriving and becoming a
// row, and — above all — what moves the watermark. withings_test.ts covers
// the client protocol against a stub; this file points the whole sync at the
// same kind of stub (WITHINGS_API_BASE) and exercises body/withings.ts
// for real, database included.
//
// Env first, imports after: db.ts reads DATABASE_URL and withings_sync.ts
// reads WITHINGS_API_BASE at module load, so both are set before the dynamic
// import below. That is also why this file cannot use static imports for the
// code under test.

const DB_URL = Deno.env.get("TEST_DATABASE_URL") ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

interface Call {
  path: string;
  params: Record<string, string>;
  auth: string | null;
}

// One weigh-in as Withings sends it: milligrams and an exponent.
function weighGroup(grpid: number, epoch: number, valueKg: number) {
  return {
    grpid,
    date: epoch,
    attrib: 0,
    category: 1,
    deviceid: null,
    measures: [{ value: Math.round(valueKg * 1000), type: 1, unit: -3 }],
  };
}

Deno.test(
  "the sync between Withings and the bodyweight table",
  // The db.ts client is a module singleton shared with any other test file
  // that imports it, so this test must not close it — the sanitizers would
  // report that open connection as a leak.
  { sanitizeResources: false, sanitizeOps: false },
  async (t) => {
    Deno.env.set("DATABASE_URL", DB_URL);
    Deno.env.set("WITHINGS_CLIENT_ID", "test-client");
    Deno.env.set("WITHINGS_CLIENT_SECRET", "test-secret");

    const calls: Call[] = [];
    let measureReply: unknown = { status: 0, body: {} };
    let oauthReply: unknown = { status: 0, body: {} };
    const stub = Deno.serve({ port: 0, onListen() {} }, async (req) => {
      const url = new URL(req.url);
      calls.push({
        path: url.pathname,
        params: Object.fromEntries(new URLSearchParams(await req.text())),
        auth: req.headers.get("authorization"),
      });
      return Response.json(
        url.pathname === "/v2/oauth2" ? oauthReply : measureReply,
      );
    });
    Deno.env.set(
      "WITHINGS_API_BASE",
      `http://127.0.0.1:${(stub.addr as Deno.NetAddr).port}`,
    );

    const { catchUp, catchUpIfDue, syncNotifiedWindow } = await import(
      "../supabase/functions/api/body/withings.ts"
    );
    const { sql } = await import("../supabase/functions/api/db.ts");

    async function seedAuth(opts: { expiresInMs?: number } = {}) {
      await sql`delete from withings_auth`;
      await sql`
        insert into withings_auth
          (id, withings_user_id, access_token, refresh_token,
           access_token_expires_at)
        values
          (1, 'user-1', 'live-token', 'stored-refresh',
           ${new Date(Date.now() + (opts.expiresInMs ?? 3_600_000))})`;
    }

    async function watermarkEpoch(): Promise<number | null> {
      const [row] = await sql`
        select extract(epoch from last_sync_at)::bigint as at
        from withings_auth where id = 1`;
      return row.at === null ? null : Number(row.at);
    }

    // Instants safely in the past, so the future-instant guard stays quiet.
    const base = Math.floor(Date.now() / 1000) - 3 * 86_400;
    const [t1, t2, t3] = [base, base + 3_600, base + 7_200];

    await t.step("the first catch-up asks for everything", async () => {
      await seedAuth();
      measureReply = {
        status: 0,
        body: {
          updatetime: base + 100,
          measuregrps: [
            weighGroup(1, t1, 82.4),
            // An objective, not a measurement — must be ignored, not written.
            { ...weighGroup(2, t2, 80.0), category: 2 },
          ],
        },
      };
      const summary = await catchUp();
      assertEquals(summary, {
        range: "since 0",
        fetched: 2,
        written: 1,
        duplicate: 0,
        ignored: 1,
        refused: 0,
      });
      const call = calls.at(-1)!;
      assertEquals(call.path, "/measure");
      assertEquals(call.params.lastupdate, "0");
      assertEquals(call.auth, "Bearer live-token");
      const [row] = await sql`
        select value_kg::float8 as kg from bodyweight
        where source = 'withings'
          and measured_at = ${new Date(t1 * 1000)}`;
      assertEquals(row.kg, 82.4);
    });

    await t.step("the watermark is Withings' clock, not ours", async () => {
      assertEquals(await watermarkEpoch(), base + 100);
    });

    await t.step(
      "a redelivery is a duplicate, and asks since the mark",
      async () => {
        measureReply = {
          status: 0,
          body: {
            updatetime: base + 200,
            measuregrps: [weighGroup(1, t1, 82.4)],
          },
        };
        const summary = await catchUp();
        assertEquals(summary.written, 0);
        assertEquals(summary.duplicate, 1);
        assertEquals(calls.at(-1)!.params.lastupdate, String(base + 100));
        assertEquals(await watermarkEpoch(), base + 200);
      },
    );

    await t.step(
      "a notified window widens by the margin and leaves the watermark alone",
      async () => {
        // The invariant the file's longest comment defends: a window sync
        // asked about ninety seconds around one weigh-in and learned nothing
        // about anything else, so it must not declare more time examined.
        measureReply = {
          status: 0,
          body: {
            updatetime: base + 900,
            measuregrps: [weighGroup(3, t3, 82.1)],
          },
        };
        const summary = await syncNotifiedWindow(t3, t3);
        assertEquals(summary.written, 1);
        const call = calls.at(-1)!;
        assertEquals(call.params.startdate, String(t3 - 60));
        assertEquals(call.params.enddate, String(t3 + 60));
        assertEquals(call.params.lastupdate, undefined);
        // Still where the last lastupdate pass left it — not base+900.
        assertEquals(await watermarkEpoch(), base + 200);
      },
    );

    await t.step(
      "an edited reading is refused without aborting the pass",
      async () => {
        // Withings redelivers an instant that already has a different value
        // (a weigh-in edited in their app). The conflict is counted, the
        // reading after it is still written, and the watermark still moves —
        // an aborted pass would replay the same conflict every six hours
        // forever.
        measureReply = {
          status: 0,
          body: {
            updatetime: base + 300,
            measuregrps: [
              weighGroup(4, t1, 83.0), // t1 already holds 82.4
              weighGroup(5, t2, 82.2),
            ],
          },
        };
        const summary = await catchUp();
        assertEquals(summary.refused, 1);
        assertEquals(summary.written, 1);
        assertEquals(await watermarkEpoch(), base + 300);
      },
    );

    await t.step(
      "a spent token refreshes first and persists what came back",
      async () => {
        await seedAuth({ expiresInMs: 30_000 }); // inside the 60 s margin
        oauthReply = {
          status: 0,
          body: {
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3_600,
          },
        };
        measureReply = {
          status: 0,
          body: { updatetime: base + 400, measuregrps: [] },
        };
        await catchUp();
        const [refresh, measure] = calls.slice(-2);
        assertEquals(refresh.path, "/v2/oauth2");
        assertEquals(refresh.params.grant_type, "refresh_token");
        assertEquals(refresh.params.refresh_token, "stored-refresh");
        assertEquals(measure.auth, "Bearer new-access");
        const [row] = await sql`
        select access_token, refresh_token from withings_auth where id = 1`;
        assertEquals(row.access_token, "new-access");
        assertEquals(row.refresh_token, "new-refresh");
      },
    );

    await t.step(
      "the health-ping catch-up is throttled by a single claim",
      async () => {
        await sql`update withings_auth set last_sync_attempt_at = now()`;
        const before = calls.length;
        assertEquals(await catchUpIfDue(), null);
        assertEquals(calls.length, before); // nothing reached the stub
        await sql`
        update withings_auth
        set last_sync_attempt_at = now() - interval '7 hours'`;
        const summary = await catchUpIfDue();
        assert(summary !== null && "range" in summary!);
      },
    );

    await t.step("a failing catch-up is swallowed, never thrown", async () => {
      // Withings being down must not make /health look down. The refusal
      // (HTTP 200, body status 401 — their way of failing) comes back as a
      // value, not an exception.
      await sql`
        update withings_auth
        set last_sync_attempt_at = now() - interval '7 hours'`;
      measureReply = { status: 401, error: "invalid token" };
      const result = await catchUpIfDue();
      assert(result !== null && "error" in result!);
      assertStringIncludes((result as { error: string }).error, "status 401");
    });

    await t.step("cleanup", async () => {
      await sql`delete from bodyweight where source = 'withings'`;
      await sql`delete from withings_auth`;
      await stub.shutdown();
    });
  },
);
