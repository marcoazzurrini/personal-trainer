// Keep `deno task test` as the public entrypoint while workerd runs the API.
// No .env, provider credentials, PostgreSQL connection or Docker is inherited.
const env: Record<string, string> = {};
for (const key of ["PATH", "HOME", "TMPDIR", "DENO_DIR", "SYSTEMROOT"]) {
  const value = Deno.env.get(key);
  if (value !== undefined) env[key] = value;
}
const child = new Deno.Command("node", {
  args: ["scripts/test-worker.mjs", ...Deno.args],
  env,
  clearEnv: true,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
const forward = () => {
  try {
    child.kill("SIGTERM");
  } catch { /* already exited */ }
};
Deno.addSignalListener("SIGTERM", forward);
Deno.addSignalListener("SIGINT", forward);
try {
  const status = await child.status;
  Deno.exitCode = status.code;
} finally {
  Deno.removeSignalListener("SIGTERM", forward);
  Deno.removeSignalListener("SIGINT", forward);
}
