import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Run the real generated deployment in workerd. An isolated config directory,
// HOME and explicit environment prevent tests from loading developer secrets.
export async function workerFixture(vars: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "trainer-worker-"));
  const config = JSON.parse(
    await readFile(".output/server/wrangler.json", "utf-8")
  );
  delete config.$schema;
  config.main = path.resolve(".output/server", config.main);
  config.assets.directory = path.resolve(
    ".output/server",
    config.assets.directory
  );
  config.vars = { ...config.vars, ...vars };
  const configPath = path.join(directory, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(directory, ".dev.vars"), "");
  await writeFile(path.join(directory, ".env"), "");
  const environment = {
    PATH: process.env.PATH,
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: path.join(directory, "wrangler.log"),
    CI: "true",
  };
  return {
    config,
    serve(port: string) {
      return spawn(
        "node",
        [path.resolve("tests/serve-worker.ts"), configPath, port],
        {
          cwd: directory,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
    },
    spawn(args: string[]) {
      return spawn(
        "node",
        [
          path.resolve("node_modules/wrangler/bin/wrangler.js"),
          ...args,
          "--config",
          configPath,
        ],
        {
          cwd: directory,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
    },
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function stopWorker(child: ChildProcess) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
}
