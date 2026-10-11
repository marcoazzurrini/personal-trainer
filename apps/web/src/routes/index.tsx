import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { Chat } from "../chat";
import { loadSession } from "../session";

const SignOut = () => (
  <form action="/auth/sign-out" method="post">
    <button className="quiet" type="submit">
      Sign out
    </button>
  </form>
);

const Home = () => {
  const access = Route.useLoaderData();
  // A restored document must re-check its session, rather than showing the
  // browser's back/forward snapshot after a sign-out in another document.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        globalThis.location.reload();
      }
    };
    globalThis.addEventListener("pageshow", restored);
    return () => globalThis.removeEventListener("pageshow", restored);
  }, []);
  return (
    <main className="app">
      <header className="topbar">
        <span className="brand">
          <i aria-hidden="true" />
          Trainer
        </span>
        {access.status !== "signed-out" && <SignOut />}
      </header>
      {access.status === "ready" && <Chat />}
      {access.status === "signed-out" && (
        <section className="notice">
          <h1>Your coach, in your pocket.</h1>
          <p className="muted">
            Sign in with your existing account. Only your account can open this
            app.
          </p>
          <a className="button" href="/auth/sign-in">
            Sign in
          </a>
        </section>
      )}
      {access.status === "forbidden" && (
        <section className="notice" role="alert">
          <h1>This account cannot open the app.</h1>
          <p className="muted">Sign out and sign in with the owner account.</p>
        </section>
      )}
      {access.status === "unavailable" && (
        <section className="notice" role="alert">
          <h1>The app is not available.</h1>
          <p className="muted">{access.message}</p>
        </section>
      )}
    </main>
  );
};

export const Route = createFileRoute("/")({
  loader: () => loadSession(),
  component: Home,
});
