import { describe, expect, it, vi } from "vitest";
import { readDashboard } from "../src/dashboard.server";
import {
  measurementDay,
  trendSegments,
  WeightData,
  weightView,
} from "../src/weight";

const data = {
  bodyweight: [{
    id: 1,
    value_kg: 80,
    measured_at: "2026-03-28T23:30:00Z",
    source: "synthetic",
  }],
  trend: [{
    day: "2026-03-29",
    weight_kg: 80,
    trend_kg: 79.4,
    interpolated: false,
  }],
};
const env = {
  ALLOWED_SUBJECT: "owner",
  TRAINER_API_ORIGIN: "https://api.example.test",
};
const session = {
  user: { id: "owner" },
  accessToken: "synthetic-private-token",
};

describe("the web/API boundary", () => {
  it("does not call the API for an absent, wrong, unconfigured or impersonated account", async () => {
    const request = vi.fn();
    expect(await readDashboard({ user: null }, env, request)).toEqual({
      status: "signed-out",
    });
    expect(
      await readDashboard({ ...session, user: { id: "other" } }, env, request),
    ).toEqual({ status: "forbidden" });
    expect((await readDashboard(session, {}, request)).status).toBe(
      "unavailable",
    );
    expect(
      (await readDashboard({ ...session, impersonator: {} }, env, request))
        .status,
    ).toBe("forbidden");
    expect(request).not.toHaveBeenCalled();
  });
  it("uses a fixed GET, no redirects, no cache, a deadline, and returns data without credentials", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({ ...data, accessToken: "must-not-leave-server" }),
    );
    expect(await readDashboard(session, env, request)).toEqual({
      status: "ready",
      data,
    });
    const [url, options] = request.mock.calls[0];
    expect(String(url)).toBe("https://api.example.test/api/bodyweight");
    expect(options.headers.Authorization).toBe(`Bearer ${session.accessToken}`);
    expect(options.cache).toBe("no-store");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it("rejects unsafe or path-bearing origins before sending credentials", async () => {
    const request = vi.fn();
    for (
      const origin of [
        "http://api.example.test",
        "https://user:pass@api.example.test",
        "https://api.example.test/api",
        "https://api.example.test?next=x",
        "ftp://api.example.test",
        "",
      ]
    ) {
      expect(
        (await readDashboard(
          session,
          { ...env, TRAINER_API_ORIGIN: origin },
          request,
        )).status,
      ).toBe("unavailable");
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("shows failures rather than an empty success and never exposes upstream error bodies", async () => {
    for (const status of [401, 403, 500, 503]) {
      const result = await readDashboard(
        session,
        env,
        vi.fn().mockResolvedValue(
          new Response("private provider detail", { status }),
        ),
      );
      expect(result.status).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("private provider detail");
    }
    expect(
      (await readDashboard(
        session,
        env,
        vi.fn().mockRejectedValue(new Error(session.accessToken)),
      )).status,
    ).toBe("unavailable");
    expect(
      (await readDashboard(
        session,
        env,
        vi.fn().mockResolvedValue(
          Response.json({ bodyweight: [], trend: null }),
        ),
      )).status,
    ).toBe("unavailable");
    expect(
      await readDashboard(
        session,
        env,
        vi.fn().mockResolvedValue(Response.json({ bodyweight: [], trend: [] })),
      ),
    ).toEqual({ status: "ready", data: { bodyweight: [], trend: [] } });
  });
});

describe("chart facts", () => {
  it("uses Rome calendar days, including DST boundaries", () => {
    expect(measurementDay("2026-03-28T23:30:00Z")).toBe("2026-03-29");
    expect(measurementDay("2026-03-29T22:30:00Z")).toBe("2026-03-30");
  });
  it("keeps the API trend unchanged and never synthesizes weigh-ins", () => {
    const parsed = WeightData.parse(data);
    const view = weightView(parsed, 30);
    expect(view.trend).toEqual(data.trend);
    expect(view.latestTrend?.trend_kg).toBe(79.4);
    expect(view.measurements).toEqual(data.bodyweight);
    expect(parsed).toEqual(data);
  });
  it("keeps missing days as separate line segments, but retains explicit interpolated days", () => {
    const point = data.trend[0];
    const trend = [{ ...point, day: "2026-03-25" }, {
      ...point,
      day: "2026-03-26",
      interpolated: true,
    }, point];
    expect(trendSegments(trend)).toEqual([trend.slice(0, 2), [point]]);
    expect(trendSegments([])).toEqual([]);
  });
  it("filters an inclusive window from the latest Rome day without changing the record", () => {
    const record = {
      ...data,
      bodyweight: [data.bodyweight[0], {
        ...data.bodyweight[0],
        id: 2,
        measured_at: "2026-02-27T12:00:00Z",
      }],
    };
    expect(weightView(record, 30).measurements).toHaveLength(1);
    expect(weightView(record, null).measurements).toHaveLength(2);
    expect(record.bodyweight[0].id).toBe(1);
  });
});
