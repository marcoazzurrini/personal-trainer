import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import nodePath from "node:path";

const root = nodePath.resolve(import.meta.dirname, "..");
const vite = nodePath.resolve(
  nodePath.dirname(createRequire(import.meta.url).resolve("vite/package.json")),
  "bin/vite.js"
);

// The Node launcher loads the development .env before starting Vite.
execFileSync("node", [vite, "--port", "3000", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});
