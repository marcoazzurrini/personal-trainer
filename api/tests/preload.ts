// The client only talks to owned local fixtures. The Worker has a separate
// Miniflare outboundService that rejects all provider requests. This fetch guard
// is not an OS sandbox; the test runner also supplies a clean environment and
// disables Bun's automatic .env loading.
// oxlint-disable-next-line unicorn/require-module-specifiers -- This import-free preload needs module scope, not global helper declarations.
export {};

const originalFetch = globalThis.fetch;

function localUrl(input: string | URL | Request): URL {
  const url = new URL(
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Fetch accepts string, URL and Request inputs; extract the URL before enforcing the loopback boundary.
    typeof input === "string" || input instanceof URL ? input : input.url
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Test HTTP requests must use an owned 127.0.0.1 fixture without credentials."
    );
  }
  return url;
}

// oxlint-disable-next-line require-await -- Keep guard failures as rejected promises, matching fetch rather than throwing synchronously.
const guardedFetch = async (
  ...args: Parameters<typeof fetch>
): Promise<Response> => {
  const [input, init] = args;
  localUrl(input);
  if (
    init &&
    (("proxy" in init && init.proxy) || ("unix" in init && init.unix))
  ) {
    throw new Error("Test HTTP requests cannot use proxies or Unix sockets.");
  }
  // Automatic redirects could leave loopback without passing this guard again.
  const redirect =
    init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
  return originalFetch(input, {
    ...init,
    redirect: redirect === "manual" ? "manual" : "error",
  });
};

globalThis.fetch = Object.assign(guardedFetch, {
  preconnect: (...args: Parameters<typeof originalFetch.preconnect>): void => {
    localUrl(args[0]);
    originalFetch.preconnect(...args);
  },
});
