import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { isDocName, MAX_DOC_NAME } from "../lib/doc_names.ts";
import { ApiError } from "../lib/errors.ts";
import {
  commentOnIssue,
  type GithubConfig,
  GithubError,
  ISSUE_KINDS,
  issueBody,
  type IssueKind,
  listCoachIssues,
  openIssue,
} from "../lib/github.ts";
import { body, idParam, optionalText, requestId, text } from "../lib/schema.ts";

// The coach's one channel for "something about this system is in the way".
// It files a GitHub issue; it never writes code, and it never edits the live
// documents. The change is made from the repository afterwards, where the
// tests and the rest of the code can be seen. So what this endpoint asks for
// is the half the coach alone has — what it did, what came back, how often —
// and not the half it would have to guess at.

const MAX_TITLE = 200;
const MAX_PROBLEM = 4_000;
const MAX_EVIDENCE = 8_000;
const MAX_SUGGESTION = 4_000;
const MAX_COMMENT = 8_000;
const MAX_DOCS = 10;

// Read per request, not at startup: the rest of the API works without
// GitHub configured, and the error should say exactly what is missing.
function config(): GithubConfig {
  const token = Deno.env.get("GITHUB_TOKEN");
  const repo = Deno.env.get("GITHUB_REPO");
  if (!token || !repo) {
    throw new ApiError(
      500,
      "Filing issues needs GITHUB_TOKEN and GITHUB_REPO configured on the server.",
    );
  }
  return {
    apiBase: Deno.env.get("GITHUB_API_BASE") ?? "https://api.github.com",
    token,
    repo,
  };
}

// Length stays a check on the parsed value rather than a schema max: the
// message is about reports, not about strings, and it is the same sentence
// for five different fields.
function capped(value: string, max: number, field: string): string {
  if (value.length > max) {
    throw new ApiError(
      422,
      `"${field}" exceeds ${max} characters. Say the essential thing; a report nobody finishes reading is not a report.`,
    );
  }
  return value;
}

// The only enum on the endpoint, and it decides what else is required. Its
// message carries the whole distinction rather than listing two words,
// because the choice is the one piece of triage the coach does for us.
const kindError = () =>
  '"kind" must be one of: bug, improvement. A bug is the system doing something wrong — a call that failed, a number that came back wrong, an error message that sent you the wrong way; it also requires "evidence". An improvement is anything that would work better, including a document that has proven incomplete or a capability the API is missing.';

const docsError = () =>
  '"docs" must be an array of document names, like ["tasks/programming"]. Leave it out if no document is involved.';

// Optional, and validated as document names rather than free text so a
// report about a document names something that can actually be fetched.
// The count and the name rules stay here: both messages number the offending
// entry, which a per-element schema error cannot phrase the same way.
function parseDocs(raw: string[] | null | undefined): string[] {
  if (raw === undefined || raw === null) return [];
  if (raw.length > MAX_DOCS) {
    throw new ApiError(
      422,
      `"docs" names at most ${MAX_DOCS} documents. A report touching more than that is really several reports.`,
    );
  }
  return raw.map((name, i) => {
    if (!isDocName(name)) {
      throw new ApiError(
        422,
        `"docs[${i}]" must be a document name as GET /docs/index writes them: lowercase words, hyphens, slashes for nesting, no extension — like "tasks/programming" (max ${MAX_DOC_NAME} chars).`,
      );
    }
    return name;
  });
}

export const issues = new OpenAPIHono();

const Issue = z.object({
  number: z.int(),
  title: z.string(),
  url: z.string(),
  kind: z.string().nullable(),
  created_at: z.string(),
});

const OpenedIssue = z.object({
  number: z.int(),
  url: z.string(),
  kind: z.enum(ISSUE_KINDS),
  title: z.string(),
});

issues.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Issues"],
    summary: "Open reports the coach has filed",
    responses: {
      200: {
        description: "Every open coach-filed issue in the repository.",
        content: {
          "application/json": {
            schema: z.object({ issues: z.array(Issue) }),
          },
        },
      },
      502: { description: "GitHub could not be reached." },
    },
  }),
  async (c) => {
    try {
      return c.json({ issues: await listCoachIssues(config()) });
    } catch (err) {
      if (err instanceof GithubError) throw new ApiError(502, err.message);
      throw err;
    }
  },
);

issues.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Issues"],
    summary: "File a report",
    description:
      "Files a GitHub issue. `evidence` is required for a bug — the call, the response, and when — because a bug that cannot be reproduced cannot be fixed. An improvement is allowed to start as an idea.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: body({
              kind: z.enum(ISSUE_KINDS, { error: kindError }),
              title: text(),
              problem: text(),
              evidence: optionalText(),
              suggestion: optionalText(),
              docs: z.array(z.string({ error: docsError }), {
                error: docsError,
              }).optional().meta({
                description:
                  'Document names as GET /docs/index writes them, like ["tasks/programming"].',
              }),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The issue that was opened.",
        content: {
          "application/json": {
            schema: z.object({ issue: OpenedIssue }),
          },
        },
      },
      200: {
        description:
          "The issue this request_id already opened. A retry, answered before anything reaches GitHub.",
        content: {
          "application/json": {
            schema: z.object({ issue: OpenedIssue }),
          },
        },
      },
      422: {
        description:
          "A bug without evidence, a field over its length, or a docs entry that is not a document name.",
      },
      502: { description: "GitHub could not be reached." },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");

    // The retry answer, before anything reaches GitHub. Same shape as the
    // creating routes that write rows: look the request up, return what it
    // already produced.
    const [existing] = await sql`
    select issue_number, url, kind, title
    from coach_issues where request_id = ${b.request_id}`;
    if (existing) {
      return c.json({
        issue: {
          number: existing.issue_number,
          url: existing.url,
          kind: existing.kind as IssueKind,
          title: existing.title,
        },
      }, 200);
    }

    const kind = b.kind;
    const title = capped(b.title, MAX_TITLE, "title");
    const problem = capped(b.problem, MAX_PROBLEM, "problem");
    // Required for a bug and optional for an improvement. A bug without the
    // call that produced it cannot be reproduced from the repository, which is
    // the only place it can be fixed — the report would arrive as a rumour. An
    // improvement is allowed to start as an idea.
    const rawEvidence = b.evidence ?? null;
    if (kind === "bug" && rawEvidence === null) {
      throw new ApiError(
        422,
        '"evidence" is required for a bug: the call you made, the response that came back, and when. Nobody can reproduce it from the repository without that, and a bug that cannot be reproduced cannot be fixed. If you cannot show it, file it as an improvement and say what you suspect.',
      );
    }
    const evidence = rawEvidence === null
      ? null
      : capped(rawEvidence, MAX_EVIDENCE, "evidence");
    const rawSuggestion = b.suggestion ?? null;
    const suggestion = rawSuggestion === null
      ? null
      : capped(rawSuggestion, MAX_SUGGESTION, "suggestion");
    const docs = parseDocs(b.docs);

    let issue: { number: number; url: string };
    try {
      issue = await openIssue(config(), {
        title,
        kind,
        body: issueBody({
          problem,
          evidence,
          suggestion,
          docs,
          requestId: b.request_id,
        }),
      });
    } catch (err) {
      if (err instanceof GithubError) throw new ApiError(502, err.message);
      throw err;
    }

    // After GitHub, so the row means the issue exists. on conflict do nothing
    // covers two retries racing each other: the second finds the issue already
    // recorded and its own insert is the one that loses, which is right —
    // either row describes the same issue.
    await sql`
    insert into coach_issues (request_id, issue_number, url, kind, title)
    values (${b.request_id}, ${issue.number}, ${issue.url}, ${kind}, ${title})
    on conflict (request_id) do nothing`;

    return c.json({ issue: { ...issue, kind, title } }, 201);
  },
);

// Hitting the same problem again belongs on the open issue, not in a second
// one: the value of a repeat is that it makes a pattern, and a pattern split
// across two issues reads as two anecdotes.
//
// No request_id here, unlike every creating POST that writes a row. A
// duplicated comment is a paragraph repeated in a thread Marco already has
// open — not a second thing to review, which is what request_id exists to
// prevent. The ledger a table would buy is not worth what it would cost.
issues.openapi(
  createRoute({
    method: "post",
    path: "/{number}/comments",
    tags: ["Issues"],
    summary: "Add to a report already open",
    description:
      "Hitting the same problem again belongs on the open issue: the value of a repeat is that it makes a pattern, and a pattern split across two issues reads as two anecdotes.",
    request: {
      params: z.object({ number: idParam("issue") }),
      body: {
        content: { "application/json": { schema: body({ note: text() }) } },
      },
    },
    responses: {
      201: {
        description: "The comment that was added.",
        content: {
          "application/json": {
            schema: z.object({ comment: z.object({ url: z.string() }) }),
          },
        },
      },
      404: { description: "No issue carries that number." },
      502: { description: "GitHub could not be reached." },
    },
  }),
  async (c) => {
    const issueNumber = c.req.valid("param").number;
    const note = capped(c.req.valid("json").note, MAX_COMMENT, "note");
    try {
      const { url } = await commentOnIssue(config(), issueNumber, note);
      return c.json({ comment: { url } }, 201);
    } catch (err) {
      if (err instanceof GithubError) {
        // A wrong number is the caller's mistake, and answering it with a 502
        // would say the server is broken when it is not. Errors are prompts.
        if (err.status === 404) {
          throw new ApiError(
            404,
            `No issue #${issueNumber} in the repository. GET /issues lists the open ones with their numbers.`,
          );
        }
        throw new ApiError(502, err.message);
      }
      throw err;
    }
  },
);
