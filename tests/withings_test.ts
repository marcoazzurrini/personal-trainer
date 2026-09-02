import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  getWeights,
  type MeasureGroup,
  refreshTokens,
  selectWeights,
  WithingsError,
} from "../api/body/withings_client.ts";
import { api, BASE, resetWithings } from "./helpers.ts";

// --- The Withings client, against a stub server ---------------------------
//
// The same split as the GitHub client: the protocol and the filter are tested
// here against a stub, and the routes' guards are tested through the running
// function further down. Nothing in this suite touches the real Withings API —
// it would need a live token, and the failures worth testing (a refusal
// disguised as HTTP 200, a token that comes back unrotated) are ones a healthy
// account will not produce on demand.

const DEVICE = "e531734a67286756f9487644ff5f1c07c5a438ef";

interface Recorded {
  path: string;
  params: Record<string, string>;
  auth: string | null;
}

function stubWithings(
  reply: (path: string, params: URLSearchParams) => unknown,
  opts: { raw?: string } = {},
) {
  const requests: Recorded[] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const params = new URLSearchParams(await req.text());
    requests.push({
      path: url.pathname,
      params: Object.fromEntries(params),
      auth: req.headers.get("authorization"),
    });
    if (opts.raw !== undefined) return new Response(opts.raw);
    return Response.json(reply(url.pathname, params));
  });
  return {
    cfg: {
      apiBase: `http://127.0.0.1:${server.addr.port}`,
      clientId: "client-id",
      clientSecret: "client-secret",
    },
    requests,
    close: () => server.shutdown(),
  };
}

function group(over: Partial<MeasureGroup> = {}): MeasureGroup {
  return {
    grpid: 1,
    date: 1786296000,
    attrib: 0,
    category: 1,
    deviceid: DEVICE,
    measures: [{ value: 72700, type: 1, unit: -3 }],
    ...over,
  };
}

Deno.test("withings tokens", async (t) => {
  await t.step("a refresh yields all three fields to persist", async () => {
    const { cfg, requests, close } = stubWithings(() => ({
      status: 0,
      body: {
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 10800,
      },
    }));
    try {
      const before = Date.now();
      const tokens = await refreshTokens(cfg, "refresh-1");
      assertEquals(tokens.accessToken, "access-2");
      assertEquals(tokens.refreshToken, "refresh-2");
      const ttl = Date.parse(tokens.expiresAt) - before;
      assert(ttl > 10_700_000 && ttl <= 10_800_000 + 5_000, `ttl ${ttl}`);

      assertEquals(requests[0].path, "/v2/oauth2");
      assertEquals(requests[0].params.grant_type, "refresh_token");
      assertEquals(requests[0].params.refresh_token, "refresh-1");
      assertEquals(requests[0].params.client_secret, "client-secret");
    } finally {
      await close();
    }
  });

  // The observed behaviour on this account, and the reason the caller writes
  // back unconditionally instead of writing back on change. A client that
  // returned nothing here would leave the caller with no token to store and no
  // way to tell that apart from "nothing changed".
  await t.step("an unrotated refresh token still comes back", async () => {
    const { cfg, close } = stubWithings(() => ({
      status: 0,
      body: {
        access_token: "access-2",
        refresh_token: "refresh-1", // identical to what was sent
        expires_in: 10800,
      },
    }));
    try {
      const tokens = await refreshTokens(cfg, "refresh-1");
      assertEquals(tokens.refreshToken, "refresh-1");
    } finally {
      await close();
    }
  });

  await t.step("a partial token set is refused, not stored", async () => {
    const { cfg, close } = stubWithings(() => ({
      status: 0,
      body: { access_token: "access-2", expires_in: 10800 }, // no refresh token
    }));
    try {
      await assertRejects(
        () => refreshTokens(cfg, "refresh-1"),
        WithingsError,
        "partial token set",
      );
    } finally {
      await close();
    }
  });
});

Deno.test("withings reads status, not the HTTP code", async (t) => {
  // The failure this whole file exists for. Withings answers 200 to its own
  // refusals; a client trusting res.ok would read an expired grant as a
  // successful call that found no measurements, which is exactly what a day
  // without a weigh-in looks like.
  await t.step("a status field that is not 0 is a failure", async () => {
    const { cfg, close } = stubWithings(() => ({
      status: 401,
      error: "invalid_token",
    }));
    try {
      await assertRejects(
        () => getWeights(cfg, "token", { lastupdate: 0 }),
        WithingsError,
        "status 401",
      );
    } finally {
      await close();
    }
  });

  await t.step(
    "a body that is not a Withings response is a failure",
    async () => {
      const { cfg, close } = stubWithings(() => ({}), {
        raw: "<html>oops</html>",
      });
      try {
        await assertRejects(
          () => getWeights(cfg, "token", { lastupdate: 0 }),
          WithingsError,
          "not a Withings response",
        );
      } finally {
        await close();
      }
    },
  );
});

Deno.test("withings measurement fetch", async (t) => {
  await t.step("carries the bearer and asks for real weights", async () => {
    const { cfg, requests, close } = stubWithings(() => ({
      status: 0,
      body: { updatetime: 1786287339, measuregrps: [group()] },
    }));
    try {
      const res = await getWeights(cfg, "access-9", {
        startdate: 100,
        enddate: 200,
      });
      assertEquals(res.updatetime, 1786287339);
      assertEquals(res.groups.length, 1);

      const req = requests[0];
      assertEquals(req.path, "/measure");
      assertEquals(req.auth, "Bearer access-9");
      assertEquals(req.params.action, "getmeas");
      assertEquals(req.params.meastype, "1");
      assertEquals(req.params.category, "1");
      assertEquals(req.params.startdate, "100");
      assertEquals(req.params.enddate, "200");
      assertEquals(req.params.lastupdate, undefined);
    } finally {
      await close();
    }
  });

  await t.step("the catch-up asks by lastupdate instead", async () => {
    const { cfg, requests, close } = stubWithings(() => ({
      status: 0,
      body: { updatetime: 5, measuregrps: [] },
    }));
    try {
      await getWeights(cfg, "access-9", { lastupdate: 1786000000 });
      assertEquals(requests[0].params.lastupdate, "1786000000");
      assertEquals(requests[0].params.startdate, undefined);
    } finally {
      await close();
    }
  });
});

Deno.test("withings scaling and filtering", async (t) => {
  await t.step("the exponent is read, not assumed", () => {
    const { accepted } = selectWeights([
      group({ grpid: 1, measures: [{ value: 72700, type: 1, unit: -3 }] }),
      group({ grpid: 2, measures: [{ value: 727, type: 1, unit: -1 }] }),
    ]);
    assertEquals(accepted.map((a) => a.valueKg), [72.7, 72.7]);
  });

  // Not an aesthetic rounding. bodyweight.value_kg is numeric(5, 2), so a
  // three-decimal value would be stored as something other than what was sent,
  // and the dedupe on redelivery compares sent against stored — every later
  // delivery of the same reading would then read as a conflicting measurement.
  await t.step("values arrive at the precision the column stores", () => {
    const { accepted } = selectWeights(
      [group({ measures: [{ value: 72655, type: 1, unit: -3 }] })],
    );
    const kg = accepted[0].valueKg;
    assert(
      Number.isInteger(Math.round(kg * 100)) &&
        Math.abs(kg * 100 - Math.round(kg * 100)) < 1e-9,
      `${kg} has more precision than numeric(5, 2) can hold`,
    );
    assert(Math.abs(kg - 72.655) <= 0.005, `${kg} is not 72.655 rounded`);
  });

  await t.step("epoch seconds become a UTC instant", () => {
    const { accepted } = selectWeights([group({ date: 1786296000 })]);
    assertEquals(accepted[0].measuredAt, new Date(1786296000000).toISOString());
  });

  // What is kept is "a real weight measurement", and nothing narrower. The
  // device is deliberately not consulted: see selectWeights for why a scale
  // Marco has not bought yet was the deciding argument.
  await t.step("objectives and non-weight groups are discarded", () => {
    const { accepted, skipped } = selectWeights([
      group({ grpid: 1 }),
      group({ grpid: 2, deviceid: null }), // entered by hand — still a weight
      group({ grpid: 3, deviceid: "a-scale-bought-next-year" }),
      group({ grpid: 4, category: 2 }), // an objective, not a measurement
      group({ grpid: 5, measures: [{ value: 20, type: 6, unit: 0 }] }), // no weight
    ]);

    assertEquals(accepted.map((a) => a.grpid), [1, 2, 3]);
    assertEquals(skipped.map((s) => s.grpid), [4, 5]);
    assert(skipped[0].why.includes("objective"));
    assert(skipped[1].why.includes("no weight measure"));
  });
});

// --- The routes, through the running function -----------------------------

Deno.test("withings routes", async (t) => {
  // Nothing seeded: these steps describe what an unconfigured install does, and
  // an install with credentials would make them call Withings for real.
  await resetWithings();

  // The exemption that makes the integration work at all. Withings cannot send
  // the coach's bearer token; if these sat behind it every notification would
  // 401 and nothing would be written, with no error anywhere Marco would look.
  await t.step("the webhook routes are reachable without a token", async () => {
    assertEquals((await api.get("/withings/callback", null)).status, 200);
    assertEquals((await api.get("/withings/notify", null)).status, 200);

    // Withings probes the callback when a subscription is created.
    const head = await fetch(`${BASE}/withings/notify`, { method: "HEAD" });
    await head.body?.cancel();
    assertEquals(head.status, 200);
  });

  const notify = (form: Record<string, string>) =>
    fetch(`${BASE}/withings/notify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });

  // Never 4xx a notification being ignored: Withings retries what looks like a
  // failure and unsubscribes a callback that keeps failing, so the polite
  // answer to an irrelevant notification protects the subscription.
  await t.step("a notification for another appli is dropped, 200", async () => {
    const res = await notify({
      appli: "4",
      userid: "49081981",
      startdate: "1786296000",
      enddate: "1786296100",
    });
    assertEquals(res.status, 200);
    await res.body?.cancel();
  });

  await t.step("a notification for another user is dropped, 200", async () => {
    const res = await notify({
      appli: "1",
      userid: "999999",
      startdate: "1786296000",
      enddate: "1786296100",
    });
    assertEquals(res.status, 200);
    await res.body?.cancel();
  });

  // The local stack has no withings_auth row, so this exercises the
  // unconfigured path: it must be quiet and it must still answer 200.
  await t.step("an unservicable notification still answers 200", async () => {
    const res = await notify({
      appli: "1",
      userid: "49081981",
      startdate: "1786296000",
      enddate: "1786296100",
    });
    assertEquals(res.status, 200);
    await res.body?.cancel();
  });

  // The other half of the split mount: only the two routes Withings calls are
  // public, and the trigger that can be pointed at Withings on demand is not.
  await t.step("the manual sync is behind the token", async () => {
    assertEquals((await api.post("/withings/sync", {}, null)).status, 401);
  });

  await t.step("the manual sync says so when nothing is seeded", async () => {
    const { status, body } = await api.post("/withings/sync", {});
    assertEquals(status, 502);
    assert(body.error.includes("withings_auth"), body.error);
  });

  // The repair handle: the ordinary catch-up asks Withings what changed since
  // it last looked, which by construction cannot restore a row deleted from
  // this side. ?since=0 re-reads everything.
  await t.step("a malformed since is refused before any call", async () => {
    for (const since of ["yesterday", "-1", "1.5"]) {
      const { status, body } = await api.post(
        `/withings/sync?since=${since}`,
        {},
      );
      assertEquals(status, 422, since);
      assert(body.error.includes("since"), body.error);
    }
  });
});

// --- The write path -------------------------------------------------------

Deno.test("a withings weigh-in is written once, however often it arrives", async (t) => {
  const measuredAt = "2025-03-04T06:12:00.000Z";
  let id: number;

  await t.step("the first delivery creates the row", async () => {
    const { status, body } = await api.post("/bodyweight", {
      value_kg: 72.66,
      measured_at: measuredAt,
      source: "withings",
    });
    assertEquals(status, 201);
    assertEquals(body.bodyweight.source, "withings");
    id = body.bodyweight.id;
  });

  // A redelivered notification and the daily catch-up both produce this call.
  // It is the property that lets two independent paths write the same reading.
  await t.step("a redelivery is a no-op, not a second row", async () => {
    const { status, body } = await api.post("/bodyweight", {
      value_kg: 72.66,
      measured_at: measuredAt,
      source: "withings",
    });
    assertEquals(status, 200);
    assertEquals(body.bodyweight.id, id);
  });

  await t.step(
    "a different value for the same instant is refused",
    async () => {
      const { status, body } = await api.post("/bodyweight", {
        value_kg: 73.10,
        measured_at: measuredAt,
        source: "withings",
      });
      assertEquals(status, 409);
      assert(body.error.includes("should not change"));
      // Both numbers, each labelled. The message once quoted only the stored
      // value, in parentheses — a caller who had just sent 73.1 read "(72.66
      // kg)" and could not tell which number was whose. An error naming two
      // values must say which is the record and which is the request.
      assert(body.error.includes("sent 73.1"), body.error);
      assert(body.error.includes("72.66 kg is already recorded"), body.error);
      // And the way out must be a path that exists, id included.
      assert(body.error.includes(`DELETE /bodyweight/${id}`), body.error);
    },
  );

  await t.step("cleanup", async () => {
    assertEquals((await api.delete(`/bodyweight/${id}`)).status, 200);
  });
});
