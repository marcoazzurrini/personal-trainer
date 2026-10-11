import { defineChart, dot, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { useMemo } from "react";

import { trendSegments } from "./weight";
import type { WeightData } from "./weight";

const date = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "Europe/Rome",
});

export const WeightChart = ({
  measurements,
  trend,
}: {
  measurements: WeightData["bodyweight"];
  trend: WeightData["trend"];
}) => {
  const definition = useMemo(() => {
    const raw = measurements.map((row) => ({
      x: Date.parse(row.measured_at),
      y: row.value_kg,
    }));
    const estimated = trend
      .filter((row) => row.interpolated)
      .map((row) => ({
        x: Date.parse(row.day),
        y: row.trend_kg,
      }));
    const xs = [
      ...raw.map((row) => row.x),
      ...trend.map((row) => Date.parse(row.day)),
    ];
    const ys = [
      ...raw.map((row) => row.y),
      ...trend.map((row) => row.trend_kg),
    ];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const padding = Math.max((maxY - minY) * 0.15, 0.5);
    return defineChart({
      marks: [
        dot(raw, { x: "x", y: "y", r: 2.5, fill: "#71717a", fillOpacity: 0.7 }),
        ...trendSegments(trend).map((segment) =>
          lineY(
            segment.map((row) => ({ x: Date.parse(row.day), y: row.trend_kg })),
            {
              x: "x",
              y: "y",
              stroke: "#fafafa",
              strokeWidth: 2,
              points: segment.length === 1,
            }
          )
        ),
        dot(estimated, {
          x: "x",
          y: "y",
          r: 3,
          fill: "#09090b",
          stroke: "#fafafa",
          strokeWidth: 1.5,
        }),
      ],
      scales: {
        x: {
          scale: scaleLinear().domain([minX - 43_200_000, maxX + 43_200_000]),
          axis: { ticks: { format: (value) => date.format(Number(value)) } },
        },
        y: {
          scale: scaleLinear().domain([minY - padding, maxY + padding]),
          grid: true,
          axis: {
            label: "kg",
            ticks: { format: (value) => Number(value).toFixed(1) },
          },
        },
      },
    });
  }, [measurements, trend]);
  return (
    <Chart
      definition={definition}
      height={200}
      ariaLabel="Bodyweight in kilograms: measured weigh-ins and the API-calculated trend. Dates use Europe/Rome."
    />
  );
};
