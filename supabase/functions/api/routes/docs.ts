import { OpenAPIHono, z } from "@hono/zod-openapi";
import { docUrl, isDocName } from "../lib/doc_names.ts";
import { ApiError } from "../lib/errors.ts";

// The skill's documents, bundled with the function and served as markdown.
// The whole point: updating the coach's knowledge is a git push.
// No allowlist — any file merged into docs/ serves on the next deploy;
// isDocName admits no dots, so a crafted path can never leave the folder.

export const docs = new OpenAPIHono();

// Described rather than declared with app.openapi(), which is the only route
// in the API that needs the distinction. createRoute() would register the
// path as Hono sees it, and `/{name}` compiles to `/:name`, which stops at a
// slash — every method/… and reference/… document would 404. So the wildcard
// stays exactly as it was and the document is told about it by hand.
//
// The one place the spec is written rather than generated, and it is written
// beside the route it describes so the two are read together.
docs.openAPIRegistry.registerPath({
  method: "get",
  // Relative to the mount, like every declared route: app.route("/docs", …)
  // supplies the prefix.
  path: "/{name}",
  tags: ["Documents"],
  summary: "Read a coaching document",
  description:
    "Markdown, not JSON. `name` may contain slashes — `index`, `method/hypertrophy`, `tasks/nutrition-logging`. GET /docs/index lists them and is the entry point for every conversation.",
  request: {
    params: z.object({
      name: z.string().meta({ example: "method/hypertrophy" }),
    }),
  },
  responses: {
    200: {
      description: "The document, as markdown.",
      content: { "text/markdown": { schema: z.string() } },
    },
    404: {
      description:
        "No such document, or a name that could not be one. GET /docs/index lists them.",
    },
  },
});

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
      `"${name}" is not a document name (lowercase words, hyphens, slashes). GET /docs/index lists the documents.`,
    );
  }
  try {
    const text = await Deno.readTextFile(docUrl(name));
    return c.text(text);
  } catch {
    throw new ApiError(
      404,
      `No document "${name}". GET /docs/index lists the documents.`,
    );
  }
});
