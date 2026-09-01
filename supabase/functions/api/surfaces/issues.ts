// The coach's one channel for "something about this system is in the way".
// It files a GitHub issue; it never writes code, and it never edits the live
// documents. The change is made from the repository afterwards, where the
// tests and the rest of the code can be seen. So what this asks for is the
// half the coach alone has — what it did, what came back, how often — and not
// the half it would have to guess at.

import { sql } from "../db.ts";
import { ApiError } from "../shared/errors.ts";
import { writeOnce } from "../shared/idempotency.ts";
import { isDocName, MAX_DOC_NAME } from "./docs.ts";
import {
  commentOnIssue,
  type GithubConfig,
  GithubError,
  issueBody,
  type IssueKind,
  listCoachIssues,
  openIssue,
} from "./github.ts";

const MAX_TITLE = 200;
const MAX_PROBLEM = 4_000;
const MAX_EVIDENCE = 8_000;
const MAX_SUGGESTION = 4_000;
const MAX_COMMENT = 8_000;
const MAX_DOCS = 10;

export interface CoachIssue {
  number: number;
  title: string;
  url: string;
  kind: string | null;
  created_at: string;
}

export interface OpenedIssue {
  number: number;
  url: string;
  kind: IssueKind;
  title: string;
}

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

/** Every open coach-filed issue in the repository. */
export async function listIssues(): Promise<CoachIssue[]> {
  try {
    return await listCoachIssues(config());
  } catch (err) {
    if (err instanceof GithubError) throw new ApiError(502, err.message);
    throw err;
  }
}

export async function fileIssue(b: {
  kind: IssueKind;
  title: string;
  problem: string;
  evidence?: string | null;
  suggestion?: string | null;
  docs?: string[];
  request_id: string;
}): Promise<{ issue: OpenedIssue; created: boolean }> {
  // The retry answer arrives before anything reaches GitHub: the row is
  // written after the issue exists, so finding one means the issue was
  // already opened and a second call must not open another.
  const { body: issue, status } = await writeOnce<
    { issue_number: number; url: string; kind: IssueKind; title: string },
    OpenedIssue,
    OpenedIssue
  >({
    table: "coach_issues",
    requestId: b.request_id,
    select: sql`issue_number, url, kind, title`,
    replay: (existing) => ({
      number: existing.issue_number,
      url: existing.url,
      kind: existing.kind,
      title: existing.title,
    }),
    write: async () => {
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

      let opened: { number: number; url: string };
      try {
        opened = await openIssue(config(), {
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
    values (${b.request_id}, ${opened.number}, ${opened.url}, ${kind}, ${title})
    on conflict (request_id) do nothing`;

      return { ...opened, kind, title };
    },
  });
  return { issue, created: status === 201 };
}

/**
 * Adds to a report already open.
 *
 * Hitting the same problem again belongs on the open issue, not in a second
 * one: the value of a repeat is that it makes a pattern, and a pattern split
 * across two issues reads as two anecdotes.
 *
 * No request_id, unlike every creating POST that writes a row. A duplicated
 * comment is a paragraph repeated in a thread Marco already has open — not a
 * second thing to review, which is what request_id exists to prevent. The
 * ledger a table would buy is not worth what it would cost.
 */
export async function commentOnReport(
  issueNumber: number,
  rawNote: string,
): Promise<{ url: string }> {
  const note = capped(rawNote, MAX_COMMENT, "note");
  try {
    return await commentOnIssue(config(), issueNumber, note);
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
}
