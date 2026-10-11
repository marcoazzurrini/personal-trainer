import { z } from "zod";

import { WeightDataSchema, weightView } from "./weight";
import { WeightChart } from "./weight-chart";

// What the coach's show_progress tool returns: the API's own numbers, selected
// but never recomputed. Anything else is not drawn.
const ProgressSchema = z.object({
  blocks: z.array(
    z.object({
      name: z.string(),
      week: z.number().int().nullable(),
      planned_weeks: z.number().int(),
      sessions_done: z.number(),
      sessions_per_week: z.number(),
    })
  ),
  bodyweight: WeightDataSchema.nullable(),
  unavailable: z.array(z.string()),
});

const day = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "Europe/Rome",
});

function weekClass(slot: number, week: number | null): string {
  if (week === null || slot > week) {
    return "";
  }
  return slot === week ? "now" : "done";
}

const Weeks = ({ week, planned }: { week: number | null; planned: number }) => (
  <span aria-hidden="true" className="weeks">
    {Array.from({ length: planned }, (_, index) => (
      <i
        className={weekClass(index + 1, week)}
        // oxlint-disable-next-line react/no-array-index-key -- Week slots have no identity beyond their position.
        key={index}
      />
    ))}
  </span>
);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A tool result is untrusted input, validated below.
export const ProgressCard = ({ data }: { data: unknown }) => {
  const parsed = ProgressSchema.safeParse(data);
  if (!parsed.success) {
    return (
      <p className="activity activity-error">
        The progress card could not be drawn from what the API returned.
      </p>
    );
  }
  const { blocks, bodyweight, unavailable } = parsed.data;
  const view = bodyweight ? weightView(bodyweight, null) : null;
  return (
    <section aria-label="Your progress" className="card">
      {blocks.map((block) => (
        <p className="block-line" key={block.name}>
          <span>
            {block.name}
            {block.week === null
              ? ""
              : ` · week ${block.week} of ${block.planned_weeks}`}
          </span>
          <Weeks planned={block.planned_weeks} week={block.week} />
        </p>
      ))}
      {view && (
        <>
          <h2>Bodyweight</h2>
          {view.latestTrend ? (
            <p className="figure">
              <strong>
                {view.latestTrend.trend_kg.toFixed(1)}
                <span>kg</span>
              </strong>
              <span className="muted">
                trend on {day.format(Date.parse(view.latestTrend.day))}
                {view.latest &&
                  ` · last weigh-in ${view.latest.value_kg.toFixed(1)} kg`}
              </span>
            </p>
          ) : (
            <p className="muted">No weigh-ins recorded yet.</p>
          )}
          {(view.measurements.length > 0 || view.trend.length > 0) && (
            <WeightChart measurements={view.measurements} trend={view.trend} />
          )}
        </>
      )}
      {unavailable.length > 0 && (
        <p className="activity activity-error">
          Not shown: {unavailable.join(", ")}.
        </p>
      )}
    </section>
  );
};
