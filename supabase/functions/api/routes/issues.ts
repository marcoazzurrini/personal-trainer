import { Hono } from "@hono/hono";
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
import {
  type Body,
  optionalString,
  readJson,
  requireIdParam,
  requireString,
  requireUuid,
} from "../lib/validate.ts";

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
function requireKind(body: Body): IssueKind {
  const v = body.kind;
  if (
    typeof v !== "string" || !(ISSUE_KINDS as readonly string[]).includes(v)
  ) {
    throw new ApiError(
      422,
      '"kind" must be one of: bug, improvement. A bug is the system doing something wrong — a call that failed, a number that came back wrong, an error message that sent you the wrong way; it also requires "evidence". An improvement is anything that would work better, including a document that has proven incomplete or a capability the API is missing.',
    );
  }
  return v as IssueKind;
}

// Optional, and validated as document names rather than free text so a
// report about a document names something that can actually be fetched.
function parseDocs(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ApiError(
      422,
      '"docs" must be an array of document names, like ["tasks/programming"]. Leave it out if no document is involved.',
    );
  }
  if (raw.length > MAX_DOCS) {
    throw new ApiError(
      422,
      `"docs" names at most ${MAX_DOCS} documents. A report touching more than that is really several reports.`,
    );
  }
  return raw.map((name, i) => {
    if (typeof name !== "string" || !isDocName(name)) {
      throw new ApiError(
        422,
        `"docs[${i}]" must be a document name as GET /docs/index writes them: lowercase words, hyphens, slashes for nesting, no extension — like "tasks/programming" (max ${MAX_DOC_NAME} chars).`,
      );
    }
    return name;
  });
}

export const issues = new Hono();

issues.get("/", async (c) => {
  try {
    return c.json({ issues: await listCoachIssues(config()) });
  } catch (err) {
    if (err instanceof GithubError) throw new ApiError(502, err.message);
    throw err;
  }
});

issues.post("/", async (c) => {
  const body = await readJson(c);
  const requestId = requireUuid(body, "request_id");

  // The retry answer, before anything reaches GitHub. Same shape as the
  // creating routes that write rows: look the request up, return what it
  // already produced.
  const [existing] = await sql`
    select issue_number, url, kind, title
    from coach_issues where request_id = ${requestId}`;
  if (existing) {
    return c.json({
      issue: {
        number: existing.issue_number,
        url: existing.url,
        kind: existing.kind,
        title: existing.title,
      },
    });
  }

  const kind = requireKind(body);
  const title = capped(requireString(body, "title"), MAX_TITLE, "title");
  const problem = capped(
    requireString(body, "problem"),
    MAX_PROBLEM,
    "problem",
  );
  // Required for a bug and optional for an improvement. A bug without the
  // call that produced it cannot be reproduced from the repository, which is
  // the only place it can be fixed — the report would arrive as a rumour. An
  // improvement is allowed to start as an idea.
  const rawEvidence = optionalString(body, "evidence");
  if (kind === "bug" && rawEvidence === null) {
    throw new ApiError(
      422,
      '"evidence" is required for a bug: the call you made, the response that came back, and when. Nobody can reproduce it from the repository without that, and a bug that cannot be reproduced cannot be fixed. If you cannot show it, file it as an improvement and say what you suspect.',
    );
  }
  const evidence = rawEvidence === null
    ? null
    : capped(rawEvidence, MAX_EVIDENCE, "evidence");
  const rawSuggestion = optionalString(body, "suggestion");
  const suggestion = rawSuggestion === null
    ? null
    : capped(rawSuggestion, MAX_SUGGESTION, "suggestion");
  const docs = parseDocs(body.docs);

  let issue: { number: number; url: string };
  try {
    issue = await openIssue(config(), {
      title,
      kind,
      body: issueBody({ problem, evidence, suggestion, docs, requestId }),
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
    values (${requestId}, ${issue.number}, ${issue.url}, ${kind}, ${title})
    on conflict (request_id) do nothing`;

  return c.json({ issue: { ...issue, kind, title } }, 201);
});

// Hitting the same problem again belongs on the open issue, not in a second
// one: the value of a repeat is that it makes a pattern, and a pattern split
// across two issues reads as two anecdotes.
//
// No request_id here, unlike every creating POST that writes a row. A
// duplicated comment is a paragraph repeated in a thread Marco already has
// open — not a second thing to review, which is what request_id exists to
// prevent. The ledger a table would buy is not worth what it would cost.
issues.post("/:number/comments", async (c) => {
  const issueNumber = requireIdParam(c.req.param("number"), "issue");
  const body = await readJson(c);
  const note = capped(requireString(body, "note"), MAX_COMMENT, "note");
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
});
