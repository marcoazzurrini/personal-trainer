import { z } from "zod";

// Validate the API boundary. Unknown fields are discarded, not sent to the
// browser. Measurements and the API's trend remain separate facts.
export const WeightData = z.object({
  bodyweight: z.array(z.object({
    id: z.number().int(),
    value_kg: z.number().finite(),
    measured_at: z.iso.datetime({ offset: true }),
    source: z.string(),
  })),
  trend: z.array(z.object({
    day: z.iso.date(),
    weight_kg: z.number().finite(),
    interpolated: z.boolean(),
    trend_kg: z.number().finite(),
  })),
});
export type WeightData = z.infer<typeof WeightData>;

const romeDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function measurementDay(instant: string): string {
  return romeDay.format(new Date(instant));
}

export function trendSegments(
  trend: WeightData["trend"],
): WeightData["trend"][] {
  const segments: WeightData["trend"][] = [];
  for (const row of trend) {
    const current = segments.at(-1);
    const previous = current?.at(-1);
    if (
      !previous || Date.parse(row.day) - Date.parse(previous.day) !== 86_400_000
    ) {
      segments.push([row]);
    } else {
      current!.push(row);
    }
  }
  return segments;
}

export function weightView(data: WeightData, days: number | null) {
  const measurements = [...data.bodyweight].sort((a, b) =>
    Date.parse(a.measured_at) - Date.parse(b.measured_at)
  );
  const trend = [...data.trend].sort((a, b) => a.day.localeCompare(b.day));
  const latest = measurements.at(-1) ?? null;
  // Anchor to the latest recorded day, not the viewer's timezone or today's
  // clock. An old record stays visible and its actual date is shown explicitly.
  const lastDay = latest
    ? measurementDay(latest.measured_at)
    : trend.at(-1)?.day;
  const cutoff = lastDay && days !== null
    ? new Date(Date.parse(lastDay) - (days - 1) * 86_400_000).toISOString()
      .slice(0, 10)
    : "";
  return {
    latest,
    latestTrend: trend.at(-1) ?? null,
    measurements: measurements.filter((row) =>
      measurementDay(row.measured_at) >= cutoff
    ),
    trend: trend.filter((row) => row.day >= cutoff),
  };
}
