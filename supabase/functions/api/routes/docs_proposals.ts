import { Hono } from "@hono/hono";
import { isDocName, MAX_DOC_NAME } from "../lib/doc_names.ts";
import { ApiError } from "../lib/errors.ts";
import {
  type DocChange,
  type GithubConfig,
  GithubError,
  listDocsProposals,
  openDocsProposal,
} from "../lib/github.ts";
import { readJson, requireString } from "../lib/validate.ts";

// The coach never edits the live docs: a proposal becomes a GitHub pull
// request, and only Marco's merge makes it real. Serving is untouched —
// merge triggers the normal deploy and the docs ship with the function.

const DOCS_DIR = "supabase/functions/api/docs";
const MAX_CHANGES = 10;
const MAX_CONTENT = 100_000;

// Read per request, not at startup: the rest of the API works without
// GitHub configured, and the error should say exactly what is missing.
function config(): GithubConfig {
  const token = Deno.env.get("GITHUB_TOKEN");
  const repo = Deno.env.get("GITHUB_REPO");
  if (!token || !repo) {
    throw new ApiError(
      500,
      "Docs proposals need GITHUB_TOKEN and GITHUB_REPO configured on the server.",
    );
  }
  return {
    apiBase: Deno.env.get("GITHUB_API_BASE") ?? "https://api.github.com",
    token,
    repo,
  };
}

function parseChanges(raw: unknown): DocChange[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(
      422,
      '"changes" is required: a non-empty array of {path, content} to create or update a document, or {path, delete: true} to remove one.',
    );
  }
  if (raw.length > MAX_CHANGES) {
    throw new ApiError(
      422,
      `A proposal carries at most ${MAX_CHANGES} changes. Split a larger rework into separate proposals.`,
    );
  }
  const seen = new Set<string>();
  return raw.map((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError(422, `"changes[${i}]" must be an object.`);
    }
    const change = item as Record<string, unknown>;
    const path = change.path;
    if (typeof path !== "string" || !isDocName(path)) {
      throw new ApiError(
        422,
        `"changes[${i}].path" must be a document name: lowercase words, hyphens, slashes for nesting, no extension — like "programming" or "method/hypertrophy" (max ${MAX_DOC_NAME} chars).`,
      );
    }
    if (seen.has(path)) {
      throw new ApiError(
        422,
        `"${path}" appears twice in changes; send one change per document.`,
      );
    }
    seen.add(path);
    const repoPath = `${DOCS_DIR}/${path}.md`;
    if (change.delete === true) {
      if (change.content !== undefined) {
        throw new ApiError(
          422,
          `"changes[${i}]" has both content and delete; a change is one or the other.`,
        );
      }
      return { repoPath, content: null };
    }
    const content = change.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new ApiError(
        422,
        `"changes[${i}].content" must be the document's full new markdown (or send delete: true to remove it).`,
      );
    }
    if (content.length > MAX_CONTENT) {
      throw new ApiError(
        422,
        `"changes[${i}].content" exceeds ${MAX_CONTENT} characters. A document that long will not fit a coaching session; trim or split it.`,
      );
    }
    return { repoPath, content };
  });
}

export const docsProposals = new Hono();

docsProposals.get("/", async (c) => {
  try {
    return c.json({ proposals: await listDocsProposals(config()) });
  } catch (err) {
    if (err instanceof GithubError) throw new ApiError(502, err.message);
    throw err;
  }
});

docsProposals.post("/", async (c) => {
  const body = await readJson(c);
  const title = requireString(body, "title");
  const rationale = requireString(body, "rationale");
  const changes = parseChanges(body.changes);
  try {
    const { prUrl, branch } = await openDocsProposal(config(), {
      title,
      rationale,
      changes,
    });
    return c.json({ proposal: { pr_url: prUrl, branch } }, 201);
  } catch (err) {
    if (err instanceof GithubError) throw new ApiError(502, err.message);
    throw err;
  }
});
