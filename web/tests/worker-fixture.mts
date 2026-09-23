import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run the real generated deployment in workerd. An isolated config directory,
// HOME and explicit environment prevent tests from loading developer secrets.
export async function workerFixture(vars: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "trainer-worker-"));
  const config = JSON.parse(
    await readFile(".output/server/wrangler.json", "utf8"),
  );
  delete config.$schema;
  config.main = resolve(".output/server", config.main);
  config.assets.directory = resolve(".output/server", config.assets.directory);
  config.vars = { ...config.vars, ...vars };
  const path = join(directory, "wrangler.json");
  await writeFile(path, JSON.stringify(config));
  await writeFile(join(directory, ".dev.vars"), "");
  await writeFile(join(directory, ".env"), "");
  const environment = {
    PATH: process.env.PATH,
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
    CI: "true",
  };
  return {
    config,
    serve(port: string) {
      return spawn(process.execPath, [
        resolve("tests/serve-worker.mjs"),
        path,
        port,
      ], {
        cwd: directory,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    spawn(args: string[]) {
      return spawn(process.execPath, [
        resolve("node_modules/wrangler/bin/wrangler.js"),
        ...args,
        "--config",
        path,
      ], {
        cwd: directory,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function stopWorker(child: ChildProcess) {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  }
}
