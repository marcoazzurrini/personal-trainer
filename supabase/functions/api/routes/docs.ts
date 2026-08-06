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
];

export const docs = new Hono();

docs.get("/:name", async (c) => {
  const name = c.req.param("name");
  if (!NAMES.includes(name)) {
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
