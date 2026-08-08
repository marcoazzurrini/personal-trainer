import { Hono } from "@hono/hono";
import { docUrl, isDocName } from "../lib/doc_names.ts";
import { ApiError } from "../lib/errors.ts";

// The skill's documents, bundled with the function and served as markdown.
// The whole point: updating the coach's knowledge is a git push.
// No allowlist — any file merged into docs/ serves on the next deploy;
// isDocName admits no dots, so a crafted path can never leave the folder.

export const docs = new Hono();

// Wildcard, not :name — document names can contain slashes (method/…).
docs.get("/*", async (c) => {
  const raw = c.req.path.split("/docs/")[1] ?? "";
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    throw new ApiError(404, `"${raw}" is not a document name.`);
  }
  if (!isDocName(name)) {
    throw new ApiError(
      404,
      `"${name}" is not a document name (lowercase words, hyphens, slashes). GET /api/docs/index lists the documents.`,
    );
  }
  try {
    const text = await Deno.readTextFile(docUrl(name));
    return c.text(text);
  } catch {
    throw new ApiError(
      404,
      `No document "${name}". GET /api/docs/index lists the documents.`,
    );
  }
});
