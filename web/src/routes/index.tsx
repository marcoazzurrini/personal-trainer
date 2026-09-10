import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { loadDashboard } from "../dashboard";
import { weightView } from "../weight";
import { WeightChart } from "../weight-chart";

export const Route = createFileRoute("/")({
  loader: () => loadDashboard(),
  pendingComponent: () => (
    <main className="page" role="status">Loading your record…</main>
  ),
  component: Dashboard,
});

const day = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Rome",
});
const instant = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Rome",
});

function Dashboard() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [days, setDays] = useState<number | null>(90);
  const [refreshing, setRefreshing] = useState(false);
  // A restored document must re-check its session, rather than showing the
  // browser's back/forward snapshot after a sign-out in another document.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) globalThis.location.reload();
    };
    globalThis.addEventListener("pageshow", restored);
    return () => globalThis.removeEventListener("pageshow", restored);
  }, []);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await router.invalidate();
    } finally {
      setRefreshing(false);
    }
  };
  const signedIn = result.status !== "signed-out";
  const view = result.status === "ready" ? weightView(result.data, days) : null;
  return (
    <main className="page">
      <header className="topbar">
        <a className="brand" href="/">
          Personal trainer<span>Your record</span>
        </a>
        {signedIn && (
          <form action="/auth/sign-out" method="post">
            <button className="quiet" type="submit">Sign out</button>
          </form>
        )}
      </header>
      <section className="intro">
        <p className="eyebrow">Bodyweight</p>
        <h1>The trend, not the noise.</h1>
        <p>
          Your measurements, with the trend calculated by your training API.
        </p>
      </section>
      {result.status === "signed-out" && (
        <section className="card message">
          <h2>A private view of your progress.</h2>
          <p>
            Sign in with your existing account. Only your account can open this
            dashboard.
          </p>
          <a className="button" href="/auth/sign-in">Sign in</a>
        </section>
      )}
      {result.status === "forbidden" && (
        <section className="card message" role="alert">
          <h2>This account cannot open the dashboard.</h2>
          <p>
            Sign out and use the account configured for this personal trainer.
          </p>
        </section>
      )}
      {result.status === "unavailable" && (
        <section className="card message" role="alert">
          <h2>Could not load your record.</h2>
          <p>{result.message}</p>
          <button type="button" onClick={refresh} disabled={refreshing}>
            Try again
          </button>
        </section>
      )}
      {view && (
        <>
          <section className="stats" aria-label="Latest recorded values">
            <div className="card stat">
              <p>Latest measurement</p>
              <strong>
                {view.latest
                  ? (
                    <>
                      {view.latest.value_kg.toFixed(1)} <span>kg</span>
                    </>
                  )
                  : "Not recorded"}
              </strong>
              <small>
                {view.latest
                  ? instant.format(new Date(view.latest.measured_at))
                  : "No weigh-ins yet"}
              </small>
            </div>
            <div className="card stat">
              <p>Latest trend</p>
              <strong>
                {view.latestTrend
                  ? (
                    <>
                      {view.latestTrend.trend_kg.toFixed(1)} <span>kg</span>
                    </>
                  )
                  : "Not available"}
              </strong>
              <small>
                {view.latestTrend
                  ? `${day.format(new Date(view.latestTrend.day))}${
                    view.latestTrend.interpolated ? " · interpolated day" : ""
                  }`
                  : "Calculated by the API when data is available"}
              </small>
            </div>
          </section>
          <section className="card chart-card" aria-labelledby="history-title">
            <div className="chart-heading">
              <h2 id="history-title">Weight history</h2>
              <div className="periods" aria-label="History window">
                {([30, 90, null] as const).map((value) => (
                  <button
                    type="button"
                    key={String(value)}
                    aria-pressed={days === value}
                    onClick={() => setDays(value)}
                  >
                    {value === null ? "All" : `${value} days`}
                  </button>
                ))}
              </div>
            </div>
            {view.measurements.length > 0 && view.trend.length === 0
              ? (
                <div className="empty" role="status">
                  <h3>No trend is available for this window.</h3>
                  <p>
                    The measurements are listed below. No replacement trend was
                    calculated.
                  </p>
                </div>
              )
              : view.trend.length > 0
              ? (
                <>
                  <ul className="legend">
                    <li>
                      <span className="raw-key" />Measurements
                    </li>
                    <li>
                      <span className="trend-key" />API trend
                    </li>
                  </ul>
                  <WeightChart
                    measurements={view.measurements}
                    trend={view.trend}
                  />
                  <p className="caption">
                    Hollow markers identify interpolated days in the API trend.
                    Missing days remain gaps. The vertical axis does not start
                    at zero.
                  </p>
                </>
              )
              : (
                <div className="empty">
                  <h3>No weight measurements yet.</h3>
                  <p>
                    Once the API has a weigh-in, your history will appear here.
                    No sample data is shown.
                  </p>
                </div>
              )}
            <div className="chart-footer">
              <p className="caption">
                Dates use Europe/Rome. Windows end at the latest recorded
                measurement, not today.
              </p>
              <button
                type="button"
                className="quiet"
                onClick={refresh}
                disabled={refreshing}
              >
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </section>
          {view.measurements.length > 0 && (
            <details className="card records">
              <summary>
                Measurements in this window ({view.measurements.length})
              </summary>
              <div className="table-scroll">
                <table>
                  <caption>
                    Recorded measurements; dates and times use Europe/Rome.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Measured at</th>
                      <th scope="col">Weight (kg)</th>
                      <th scope="col">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...view.measurements].reverse().map((row) => (
                      <tr key={row.id}>
                        <td>{instant.format(new Date(row.measured_at))}</td>
                        <td>{row.value_kg.toFixed(1)}</td>
                        <td>{row.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
      <footer className="page-footer">
        Read-only dashboard. Your training and nutrition record stays in the
        API.
      </footer>
    </main>
  );
}
