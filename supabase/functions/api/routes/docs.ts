import { Hono } from "@hono/hono";
import { ApiError } from "../lib/errors.ts";

// The skill's documents, bundled with the function and served as markdown.
// The whole point: updating the coach's knowledge is a git push.
const NAMES = [
  "index",
  "programming",
  "session-generation",
  "logging",
  "evaluation",
  "charts",
  "method/hypertrophy",
];

export const docs = new Hono();

// Wildcard, not :name — document names can contain slashes (method/…).
docs.get("/*", async (c) => {
  const raw = c.req.path.split("/docs/")[1] ?? "";
  const name = decodeURIComponent(raw);
  // NAMES is a closed list, so a crafted path can never reach the filesystem;
  // the explicit traversal check is belt and braces.
  if (name.includes("..") || name.startsWith("/") || !NAMES.includes(name)) {
    throw new ApiError(
      404,
      `No document "${name}". Available: ${NAMES.join(", ")}.`,
    );
  }
  try {
    const text = await Deno.readTextFile(
      new URL(`../docs/${name}.md`, import.meta.url),
    );
    return c.text(text);
  } catch {
    throw new ApiError(404, `"${name}" is not written yet.`);
  }
});
