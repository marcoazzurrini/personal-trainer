import { assert, assertEquals } from "@std/assert";

// Workers have no application-owned listening socket, SQL pool or SIGTERM hook.
// This checks the local runner's owned resources, not a fictional production drain.
Deno.test("the Worker contract runner disposes its listener on SIGTERM", async () => {
  const child = new Deno.Command("node", {
    args: ["scripts/test-worker.mjs", "--lifecycle-probe"],
    stdout: "piped",
    stderr: "inherit",
    clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "", HOME: Deno.env.get("HOME") ?? "" },
  }).spawn();
  let terminated = false;
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* Already exited. */ }
  }, 45000);
  try {
    let output = "";
    let origin: string | undefined;
    while (!origin) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Worker runner exited before readiness.");
      output += value;
      origin = /LIFECYCLE_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    }
    const health = await fetch(`${origin}/api/health`);
    assertEquals(health.status, 200);
    await health.body?.cancel();
    const started = performance.now();
    child.kill("SIGTERM");
    const status = await child.status;
    terminated = true;
    // Miniflare may terminate with 143 before our async stop resolves. Either
    // exit path must fail the interrupted run, close the listener and clean up.
    assert(status.code !== 0, "Interrupted tests must never report success.");
    assert(
      performance.now() - started < 10000,
      "Runner exceeded its disposal budget.",
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
      } catch { /* Already exited. */ }
      await child.status;
    }
    await reader.cancel();
    reader.releaseLock();
  }
});
