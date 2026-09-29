import { test } from "node:test";

import { assert, assertEquals } from "../api/tests/assertions.ts";
// Workers have no application-owned listening socket, SQL pool or SIGTERM hook.
// This checks the local runner's owned resources, not a fictional production drain.
test("the Worker contract runner disposes its listener on SIGTERM", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "scripts/test-worker.mjs",
      "--lifecycle-probe",
    ],
    {
      stdout: "pipe",
      stderr: "inherit",
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
    }
  );
  let terminated = false;
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Already exited. */
    }
  }, 45_000);
  try {
    let output = "";
    let origin: string | undefined;
    while (!origin) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("Worker runner exited before readiness.");
      }
      output += value;
      origin = /LIFECYCLE_READY (?<origin>http:\/\/127\.0\.0\.1:\d+)/u.exec(
        output
      )?.groups?.origin;
    }
    const health = await fetch(`${origin}/api/health`);
    assertEquals(health.status, 200);
    await health.body?.cancel();
    const started = performance.now();
    child.kill("SIGTERM");
    const code = await child.exited;
    terminated = true;
    // Miniflare may terminate with 143 before our async stop resolves. Either
    // exit path must fail the interrupted run, close the listener and clean up.
    assert(code !== 0, "Interrupted tests must never report success.");
    assert(
      performance.now() - started < 10_000,
      "Runner exceeded its disposal budget."
    );
    let refused = false;
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
    } catch {
      refused = true;
    }
    assert(refused, "Disposed Worker must stop accepting requests.");
  } finally {
    clearTimeout(timeout);
    if (!terminated) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
      await child.exited;
    }
    await reader.cancel();
    reader.releaseLock();
  }
});
