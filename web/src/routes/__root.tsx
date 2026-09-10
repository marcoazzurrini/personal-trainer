import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import styles from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Your record · Personal trainer" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "theme-color", content: "#f6f5f0" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  component: Outlet,
  shellComponent: Shell,
  errorComponent: () => (
    <main className="page">
      <h1>Dashboard unavailable</h1>
      <p>
        Try again in a moment. If this persists, check the web server
        configuration.
      </p>
      <a href="/">Reload dashboard</a>
    </main>
  ),
  notFoundComponent: () => (
    <main className="page">
      <h1>Page not found</h1>
      <a href="/">Open dashboard</a>
    </main>
  ),
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
