import { describe, expect, it } from "bun:test";

import { CARD_DAYS, progressCard } from "../src/progress.ts";

const training = {
  status: 200,
  body: {
    now: { date: "2026-10-11" },
    mesocycles: [
      {
        name: "Hypertrophy 2",
        track: "hypertrophy",
        week: 4,
        planned_weeks: 6,
        this_week: { sessions_done: 2, sessions_per_week: 4 },
        exercises: [],
      },
    ],
  },
};

function day(offset: number): string {
  return new Date(Date.parse("2026-10-11") - offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// The card selects from the API's replies and never fills a gap: every value
// it carries is one the API returned, and a failed read is named, not guessed.
describe("the progress card", () => {
  it("keeps the API's own numbers for the block and the recent weeks", () => {
    const old = {
      day: day(CARD_DAYS),
      weight_kg: 90,
      interpolated: false,
      trend_kg: 90,
    };
    const recent = {
      day: day(0),
      weight_kg: 82.1,
      interpolated: false,
      trend_kg: 82.4,
    };
    const card = progressCard(training, {
      status: 200,
      body: {
        bodyweight: [
          {
            id: 1,
            value_kg: 82.1,
            measured_at: `${day(0)}T07:12:00+02:00`,
            source: "withings",
          },
          {
            id: 2,
            value_kg: 90,
            measured_at: `${day(CARD_DAYS)}T07:00:00+02:00`,
            source: "withings",
          },
        ],
        trend: [old, recent],
      },
    });
    expect(card.blocks).toEqual([
      {
        name: "Hypertrophy 2",
        track: "hypertrophy",
        week: 4,
        planned_weeks: 6,
        sessions_done: 2,
        sessions_per_week: 4,
      },
    ]);
    expect(card.bodyweight?.trend).toEqual([recent]);
    expect(card.bodyweight?.bodyweight.map((row) => row.id)).toEqual([1]);
    expect(card.unavailable).toEqual([]);
  });

  it("names a read that failed instead of drawing anything for it", () => {
    const card = progressCard(training, {
      status: 500,
      body: { error: "Something broke." },
    });
    expect(card.bodyweight).toBeNull();
    expect(card.unavailable).toEqual(["bodyweight answered 500"]);
  });

  it("shows no block when there is no plan", () => {
    const card = progressCard(
      { status: 200, body: { mesocycles: [] } },
      { status: 200, body: { bodyweight: [], trend: [] } }
    );
    expect(card).toEqual({
      blocks: [],
      bodyweight: { bodyweight: [], trend: [] },
      unavailable: [],
    });
  });
});
